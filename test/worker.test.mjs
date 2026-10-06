// worker.js 行为用例：同一套用例同时跑在「可读版」与「压缩版(Snippets)」产物上，
// 任何行为差异都会让测试失败——这是压缩版可发布的前提。
//
// 跑法：npm test

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  loadWorkers, openSession, connectFrame, frame, T, waitFor, sockets, resetStub, setPolicy, setWriteHook,
  freshWorker, env,
} from "./harness.mjs";

const workers = await loadWorkers();
const VARIANTS = [
  ["可读版", workers.dev],
  ["压缩版", workers.min],
];

// 纯函数：源文件里未导出，通过 evaluate 暴露（与产物无关，只测解析/配置逻辑）
// 注意：splitList/dedupList 目前定义在 fetch() 内部，模块级取不到（由 E2E 用例间接覆盖）
async function loadInternals() {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  const body = src
    .replace(/^import[\s\S]*?;$/m, "")
    .replace(/export default \{[\s\S]*?\n\};/, ""); // 去掉 fetch 入口
  const fn = new Function(
    `${body}\nreturn { parseAddress, parseFallbackEntry, normalizeNodeEntry, buildConfigFromEnv, parseEnvBool, parseEnvInt, cleanLog, parseSocks5Config, socks5TargetAddr };`,
  );
  return fn();
}

/** 在 stub socket 上扮演 socks5 代理：按序回复握手，返回捕到的 CONNECT 目标 */
async function socks5Server(sock, { auth } = {}) {
  const out = {};
  // 1) 方法协商
  await waitFor(() => sock.toTarget.length >= 1, { label: "代理收到 greeting" });
  const greeting = Buffer.from(sock.toTarget[0]);
  out.greeting = greeting;
  if (greeting[0] !== 5) throw new Error(`非 SOCKS5 greeting: ${greeting}`);
  const methods = [...greeting.subarray(2)];
  let method = 0;
  if (auth) {
    if (!methods.includes(2)) throw new Error("客户端未提议 user/pass");
    method = 2;
  } else if (methods.includes(0)) {
    method = 0;
  } else {
    sock.enqueueToClient([5, 0xff]);
    throw new Error("客户端未提议无认证");
  }
  sock.enqueueToClient([5, method]);
  // 2)（可选）认证子协商
  if (method === 2) {
    await waitFor(() => sock.toTarget.length >= 2, { label: "代理收到认证凭据" });
    out.authSeen = Buffer.from(sock.toTarget[1]);
    sock.enqueueToClient([1, 0]);
  }
  // 3) CONNECT 请求
  const reqIdx = method === 2 ? 2 : 1;
  await waitFor(() => sock.toTarget.length >= reqIdx + 1, { label: "代理收到 CONNECT" });
  const req = Buffer.from(sock.toTarget[reqIdx]);
  if (req[0] !== 5 || req[1] !== 1) throw new Error(`非 CONNECT 请求: ${req}`);
  let addr;
  if (req[3] === 1) addr = [...req.subarray(4, 8)];
  else if (req[3] === 3) addr = req.subarray(5, 5 + req[4]).toString();
  else if (req[3] === 4) addr = [...req.subarray(4, 20)];
  else throw new Error(`未知 ATYP ${req[3]}`);
  out.connect = { atyp: req[3], addr, port: req[req.length - 2] * 256 + req[req.length - 1] };
  sock.enqueueToClient([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]); // 成功，BND=IPv4
  return out;
}

const internals = await loadInternals();

describe("纯函数", () => {
  test("parseAddress 解析 host:port 与 [ipv6]:port，非法地址返回 null", () => {
    const p = internals.parseAddress;
    assert.deepEqual(p("example.com:443"), { host: "example.com", port: 443 });
    assert.deepEqual(p("[2606:4700::1]:443"), { host: "2606:4700::1", port: 443 });
    // gcm 客户端发的是无方括号形态（net.SplitHostPort 后拼接）
    assert.deepEqual(p("2606:4700::1:443"), { host: "2606:4700::1", port: 443 });
    assert.equal(p("example.com"), null, "缺端口应判非法");
    assert.equal(p("example.com:0"), null);
    assert.equal(p("example.com:70000"), null);
    assert.equal(p("example.com:https"), null);
    assert.equal(p(":443"), null, "空 host 应判非法");
    assert.equal(p(""), null);
    assert.equal(p("[2606:4700::1]"), null, "方括号 IPv6 缺端口应判非法");
    assert.equal(p("[2606:4700::1]443"), null);
  });

  test("parseFallbackEntry 覆盖 host / host:port / [ipv6] / [ipv6]:port / 非法项", () => {
    const p = internals.parseFallbackEntry;
    assert.deepEqual(p("1.2.3.4", 8080), { host: "1.2.3.4", port: 8080 });
    assert.deepEqual(p("1.2.3.4:9000", 8080), { host: "1.2.3.4", port: 9000 });
    assert.deepEqual(p("[2606:4700::1]", 8080), { host: "2606:4700::1", port: 8080 });
    assert.deepEqual(p("[2606:4700::1]:9000", 8080), { host: "2606:4700::1", port: 9000 });
    assert.equal(p("", 8080), null);
    assert.equal(p("1.2.3.4:notaport", 8080), null, "非数字端口应判非法而非回退默认端口");
    assert.equal(p("1.2.3.4:0", 8080), null, "端口 0 非法");
    assert.equal(p("1.2.3.4:70000", 8080), null, "端口越界非法");
    // 裸 IPv6（无方括号）此前会被 lastIndexOf 误拆成 host=":" port=1，现按裸 IPv6 处理并继承端口
    assert.deepEqual(p("::1", 8080), { host: "::1", port: 8080 });
    assert.deepEqual(p("2606:4700::1", 8080), { host: "2606:4700::1", port: 8080 });
    assert.deepEqual(p("[2606:4700::1]", 8080), { host: "2606:4700::1", port: 8080 });
    assert.equal(p("example.com:notaport", 8080), null, "域名+非数字端口应判非法");
  });

  test("normalizeNodeEntry 给裸 IPv6 加方括号、校验端口", () => {
    const n = internals.normalizeNodeEntry;
    assert.equal(n("2606:4700::1", ""), "[2606:4700::1]");
    assert.equal(n("1.2.3.4", "8080"), "1.2.3.4:8080");
    assert.equal(n("1.2.3.4", "0"), null);
    assert.equal(n("1.2.3.4", "99999"), null);
    assert.equal(n("  ", ""), null);
    // address 字段自带端口时不能加方括号，否则 connect 会拿到 "1.2.3.4:8081" 这种畸形主机名
    assert.equal(n("1.2.3.4:8081", ""), "1.2.3.4:8081");
    assert.equal(n("[2606:4700::1]:8081", ""), "[2606:4700::1]:8081");
    const parsed = internals.parseFallbackEntry(n("1.2.3.4:8081", ""), 443);
    assert.equal(parsed && parsed.host, "1.2.3.4", "自带端口的条目应被正确拆分出 host");
    assert.equal(parsed && parsed.port, 8081, "自带端口的条目应被正确拆分出 port");
  });

  test("parseSocks5Config：scheme/凭据/端口/IPv6 形态，缺端口默认 1080", () => {
    const p = internals.parseSocks5Config;
    assert.deepEqual(p("1.2.3.4:1080"), { host: "1.2.3.4", port: 1080, user: "", pass: "" });
    assert.deepEqual(p("socks5://1.2.3.4"), { host: "1.2.3.4", port: 1080, user: "", pass: "" });
    assert.deepEqual(p("socks5h://user:pass@1.2.3.4:1081"), { host: "1.2.3.4", port: 1081, user: "user", pass: "pass" });
    assert.deepEqual(p("u:p@[2606:4700::1]:1080"), { host: "2606:4700::1", port: 1080, user: "u", pass: "p" });
    assert.deepEqual(p("proxy.example"), { host: "proxy.example", port: 1080, user: "", pass: "" });
    assert.equal(p(""), null);
    assert.equal(p("1.2.3.4:99999"), null);
    assert.equal(p("1.2.3.4:notaport"), null);
  });

  test("socks5TargetAddr：IPv4→ATYP1 / 域名与 IPv6(文字)→ATYP3", () => {
    const t = internals.socks5TargetAddr;
    const v4 = t("1.2.3.4");
    assert.equal(v4.atyp, 1);
    assert.deepEqual([...v4.addr], [1, 2, 3, 4]);
    // 裸 IPv6 按 ATYP3 字面量传（体积预算内不内嵌 v6→16 字节解析器；多数 socks5 服务端能按字面量解析）
    const v6 = t("2606:4700::1");
    assert.equal(v6.atyp, 3);
    assert.equal(v6.addr.length, 12); // "2606:4700::1" 12 字符
    assert.equal(v6.addr[0], 0x32); // '2'
    const dom = t("example.com");
    assert.equal(dom.atyp, 3);
    assert.equal(dom.addr.length, 11);
    assert.equal(t(""), null);
    assert.equal(t("999.1.1.1"), null, "非法 IPv4 不落 ATYP1");
  });

  test("buildConfigFromEnv 解析布尔/整数并做范围钳制", () => {
    const c = internals.buildConfigFromEnv;
    const dflt = c({});
    assert.equal(dflt.enableFallback, true);
    assert.equal(dflt.connectTimeout, 1000);
    assert.equal(dflt.maxStreamsPerConnection, 16);
    assert.equal(dflt.dynamicNodesUrl, "");
    assert.equal(dflt.maxPendingBytes, 1048576, "早期数据缓存默认 1MiB");
    assert.equal(dflt.maxFallbackIPs, 16);

    const custom = c({
      ENABLE_FALLBACK: "off",
      CONNECT_TIMEOUT: "50", // 低于 min=100 → 回退默认
      MAX_STREAMS_PER_CONNECTION: "999", // 高于 max=256 → 回退默认
      MAX_PENDING_BYTES: "100", // 低于 min=16384 → 回退默认
      MAX_PENDING_BYTES_LOW: null,
      MAX_FALLBACK_IPS: "1000", // 高于 max=64 → 回退默认
      DYNAMIC_NODES_URL: " https://nodes.example/api ",
    });
    assert.equal(custom.enableFallback, false);
    assert.equal(custom.connectTimeout, 1000);
    assert.equal(custom.maxStreamsPerConnection, 16);
    assert.equal(custom.maxPendingBytes, 1048576);
    assert.equal(custom.maxFallbackIPs, 16);
    assert.equal(custom.dynamicNodesUrl, "https://nodes.example/api");

    assert.equal(c({ MAX_PENDING_BYTES: "65536" }).maxPendingBytes, 65536);
    assert.equal(c({ MAX_FALLBACK_IPS: "4" }).maxFallbackIPs, 4);

    assert.equal(c({ ENABLE_LOGGING: "1" }).enableLogging, true);
    assert.equal(c({ ENABLE_LOGGING: "yes" }).enableLogging, true);
    assert.equal(c({ ENABLE_LOGGING: "nope" }).enableLogging, false, "无法识别的值回退默认");
    assert.equal(c({ ENABLE_DYNAMIC_NODES: "off" }).enableDynamicNodes, false);
  });

  test("环境变量列表解析：逗号分隔、去空白、去重（经 ?fallbackip= 与 FALLBACK_IPS 间接覆盖）", () => {
    // 见端到端用例「?fallbackip= 逐个尝试并去重」
    assert.equal(typeof internals.buildConfigFromEnv, "function");
  });
});

for (const [label, worker] of VARIANTS) {
  describe(`端到端 [${label}]`, () => {
    beforeEach(() => {
      resetStub();
    });

    test("路径不匹配返回 403 伪装页", async () => {
      const { res } = await openSession(worker, { path: "/wrong" });
      assert.equal(res.status, 403);
      assert.match(String(res.headers["Content-Type"]), /text\/html/);
      assert.match(await res.text(), /not allowed/i);
    });

    test("非 WebSocket 升级返回 426", async () => {
      const { res } = await openSession(worker, { upgrade: null });
      assert.equal(res.status, 426);
    });

    test("USER_ID 路径小写匹配", async () => {
      const { res } = await openSession(worker, { envVars: { USER_ID: "AbC" }, path: "/abc" });
      assert.equal(res.status, 101);
    });

    test("CONNECT → CONNECTED → DATA 双向 → CLOSE", async () => {
      const { res, server } = await openSession(worker);
      assert.equal(res.status, 101);
      assert.ok(server.accepted);

      await server.fromClient(connectFrame(1, "example.com", 443));
      await waitFor(() => server.typesOf(1).includes(T.CONNECTED), { label: "CONNECTED" });

      const sock = sockets()[0];
      assert.deepEqual(sock.opts, { hostname: "example.com", port: 443 });

      // 客户端 → 目标
      await server.fromClient(frame(1, T.DATA, "hello"));
      await waitFor(() => sock.toTarget.length === 1, { label: "写入目标" });
      assert.equal(Buffer.from(sock.toTarget[0]).toString(), "hello");

      // 目标 → 客户端
      sock.enqueueToClient([0xde, 0xad]);
      await waitFor(() => server.typesOf(1).includes(T.DATA), { label: "回程 DATA" });
      assert.deepEqual([...server.payloadOf(1, T.DATA)], [0xde, 0xad]);

      // 目标 EOF → 服务端发 CLOSE 并清理流
      sock.eofToClient();
      await waitFor(() => server.typesOf(1).includes(T.CLOSE), { label: "CLOSE" });
    });

    test("socket.opened 兑现值不是 socket 本身：建流只能用 connect() 返回的那个（回归：线上预热正常、每个代理请求秒 CLOSE）", async () => {
      // 真实 workerd：`await socket.opened` 兑现的是内部对象（无 readable/writable/close）。
      // dialWithTimeout 曾把这个兑现值当 socket 返回，`.writable.getWriter()` 抛
      // TypeError「Cannot read properties of undefined (reading 'getWriter')」，
      // 于是**每条成功建连的流都当场失败**，客户端只看到 CLOSE
      // （Worker 日志：每个出口都「失败: ...getWriter」）。
      // 替身按真实语义兑现，本用例钉住这条契约 + 正常建流确实拿到 CONNECTED。
      const { server } = await openSession(worker);
      await server.fromClient(connectFrame(31, "opened.example", 443));
      await waitFor(() => sockets().length >= 1, { label: "拨出" });
      const sock = sockets()[0];
      const openedValue = await sock.socket.opened;
      assert.notEqual(openedValue, sock.socket, "opened 兑现值必须 ≠ socket（与真实 workerd 一致）");
      assert.equal(openedValue.writable, undefined, "opened 兑现值不得带 writable");
      await waitFor(() => server.typesOf(31).includes(T.CONNECTED), { label: "CONNECTED" });
    });

    test("TCP 未连上时的早期 DATA 被缓存并在连上后 flush", async () => {
      setPolicy(() => "hang");
      const { server } = await openSession(worker, { envVars: { CONNECT_TIMEOUT: "100000" } });
      await server.fromClient(connectFrame(7, "slow.example", 443));
      await server.fromClient(frame(7, T.DATA, "early-1"));
      await server.fromClient(frame(7, T.DATA, "early-2"));

      // 手动放行连接
      const sock = sockets()[0];
      sock.resolveOpened();
      await waitFor(() => server.typesOf(7).includes(T.CONNECTED), { label: "CONNECTED" });
      await waitFor(() => sock.toTarget.length === 2, { label: "flush 缓存" });
      assert.deepEqual(sock.toTarget.map((b) => Buffer.from(b).toString()), ["early-1", "early-2"]);
      // CONNECTED 必须是该流的第一帧（缓存期不得回发 DATA）
      assert.equal(server.typesOf(7)[0], T.CONNECTED);
    });

    test("早期数据缓存超上限：回 CLOSE 并关流（回归：可撑爆 isolate 内存）", async () => {
      setPolicy(() => "hang");
      const { server } = await openSession(worker, {
        envVars: { CONNECT_TIMEOUT: "30000", MAX_PENDING_BYTES: "16384" },
      });
      await server.fromClient(connectFrame(4, "slow.example", 443));
      await server.fromClient(frame(4, T.DATA, new Uint8Array(10 * 1024)));
      await server.fromClient(frame(4, T.DATA, new Uint8Array(10 * 1024))); // 累计 20KiB > 16KiB
      await waitFor(() => server.typesOf(4).includes(T.CLOSE), { label: "超限 CLOSE" });
      assert.equal(sockets()[0].closed, true, "socket 应被回收");
    });

    test("?fallbackip= 条数超上限被截断（回归：单条 CONNECT 拉出超长拨号链）", async () => {
      setPolicy(() => "reject");
      const many = Array.from({ length: 12 }, (_, i) => `fb${i}.example`).join(",");
      const { server } = await openSession(worker, {
        query: `?fallbackip=${many}`,
        envVars: { MAX_FALLBACK_IPS: "3" },
      });
      await server.fromClient(connectFrame(3, "direct.example", 443));
      await waitFor(() => server.typesOf(3).includes(T.CLOSE), { label: "全败 CLOSE" });
      assert.equal(sockets().length, 4, "直连 + 3 条被截断后的 query 回退（不再拨第 4 条起）");
    });

    test("flush 后在途额度释放：早期数据不永久占用预算（回归：健康长连流被误杀）", async () => {
      // 预连接期灌 60KiB 早期数据（< 64KiB 上限），flush 完再发 8KiB：额度已释放则不得触发 CLOSE
      setPolicy(() => "hang");
      const { server } = await openSession(worker, {
        envVars: { CONNECT_TIMEOUT: "30000", MAX_PENDING_BYTES: "65536" },
      });
      await server.fromClient(connectFrame(4, "slow.example", 443));
      await server.fromClient(frame(4, T.DATA, new Uint8Array(60 * 1024)));
      const sock = sockets()[0];
      sock.resolveOpened();
      await waitFor(() => server.typesOf(4).includes(T.CONNECTED), { label: "CONNECTED" });
      await waitFor(() => sock.toTarget.length >= 1, { label: "早期数据已 flush" });

      await server.fromClient(frame(4, T.DATA, new Uint8Array(8 * 1024)));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(server.typesOf(4).includes(T.CLOSE), false, `flush 后额度未释放，健康流被误杀（frames: ${JSON.stringify(server.typesOf(4))}）`);
      assert.equal(sock.closed, false, "socket 不该被关");
      await waitFor(() => sock.toTarget.length >= 2, { label: "后续 DATA 正常写出" });
    });

    test("出口优先级完整链：直连 > ?fallbackip > 动态节点 > 静态（对外契约）", async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ nodes: [{ ip: "dyn.example" }] }) });
      try {
        setPolicy(() => "reject");
        const w = await freshWorker(worker === workers.min ? "min" : "dev");
        const { server } = await openSession(w, {
          query: "?fallbackip=q.example",
          envVars: { DYNAMIC_NODES_URL: "https://nodes.example/api", FALLBACK_IPS: "static.example" },
        });
        await server.fromClient(connectFrame(9, "direct.example", 443));
        await waitFor(() => server.typesOf(9).includes(T.CLOSE), { label: "全链失败 CLOSE" });
        assert.deepEqual(
          sockets().map((s) => s.opts.hostname),
          ["direct.example", "q.example", "dyn.example", "static.example"],
          "出口顺序是 AGENTS 约束 6 的对外契约",
        );
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    test("?proxy-all=true：只用 socks5 出口，直连与 L4 链完全不碰（新语义）", async () => {
      setPolicy((opts) => (opts.hostname === "sockshost.example" ? "open" : "reject"));
      const { server } = await openSession(worker, {
        query: "?fallbackip=sockshost.example:1080&proxy-all=true",
        envVars: { FALLBACK_IPS: "static.example" },
      });
      await server.fromClient(connectFrame(11, "direct.example", 443));
      await waitFor(() => sockets().length >= 1, { label: "拨 socks5 出口" });
      const hs = await socks5Server(sockets()[0]);
      await waitFor(() => server.typesOf(11).includes(T.CONNECTED), { label: "CONNECTED" });
      assert.deepEqual(
        sockets().map((s) => s.opts.hostname),
        ["sockshost.example"],
        "直连与 static.example 都不该出现",
      );
      assert.deepEqual([...hs.greeting], [5, 1, 0], "无认证 greeting");
      assert.equal(hs.connect.addr, "direct.example", "目标域名原样交给代理");
      assert.equal(hs.connect.port, 443, "目标端口原样交给代理");
      assert.equal(server.typesOf(11)[0], T.CONNECTED, "CONNECTED 是第一帧");
    });

    test("socks5 首代理拒绝方法 → 自动试下一个并成功", async () => {
      setPolicy((opts) => ["p1.example", "p2.example"].includes(opts.hostname) ? "open" : "reject");
      const { server } = await openSession(worker, {
        query: "?fallbackip=p1.example:1080,p2.example:1080&proxy-all=true",
      });
      await server.fromClient(connectFrame(12, "target.example", 443));
      await waitFor(() => sockets().length >= 1, { label: "拨 p1" });
      const s1 = sockets()[0];
      await waitFor(() => s1.toTarget.length >= 1, { label: "p1 收到 greeting" });
      s1.enqueueToClient([5, 0xff]); // 拒绝所有方法
      await waitFor(() => sockets().length >= 2, { label: "拨 p2" });
      const hs = await socks5Server(sockets()[1]);
      await waitFor(() => server.typesOf(12).includes(T.CONNECTED), { label: "p2 CONNECTED" });
      assert.deepEqual(sockets().map((s) => s.opts.hostname), ["p1.example", "p2.example"]);
      assert.equal(hs.connect.addr, "target.example");
    });

    test("socks5 出口来自 SOCKS5_PROXY 环境变量（无需 ?fallbackip=）", async () => {
      setPolicy((opts) => (opts.hostname === "envproxy.example" ? "open" : "reject"));
      const { server } = await openSession(worker, {
        query: "?proxy-all=true",
        envVars: { SOCKS5_PROXY: "envproxy.example:1080" },
      });
      await server.fromClient(connectFrame(13, "example.com", 443));
      await waitFor(() => sockets().length >= 1, { label: "拨环境变量 sock5" });
      const hs = await socks5Server(sockets()[0]);
      await waitFor(() => server.typesOf(13).includes(T.CONNECTED), { label: "CONNECTED" });
      assert.equal(hs.connect.addr, "example.com");
    });

    test("socks5 带 user:pass 认证：只提议 0x02 且认证子协商正确", async () => {
      setPolicy((opts) => (opts.hostname === "auth.example" ? "open" : "reject"));
      const { server } = await openSession(worker, {
        query: "?fallbackip=user:pass@auth.example:1080&proxy-all=true",
      });
      await server.fromClient(connectFrame(14, "example.com", 443));
      await waitFor(() => sockets().length >= 1, { label: "拨带认证 proxy" });
      const hs = await socks5Server(sockets()[0], { auth: "user:pass" });
      await waitFor(() => server.typesOf(14).includes(T.CONNECTED), { label: "CONNECTED" });
      assert.deepEqual([...hs.greeting], [5, 1, 2], "有凭据应只提议 user/pass");
      const a = hs.authSeen;
      assert.equal(a[0], 1);
      assert.equal(a[1], 4);
      assert.equal(a.subarray(2, 6).toString(), "user");
      assert.equal(a[6], 4);
      assert.equal(a.subarray(7, 11).toString(), "pass");
    });

    test("proxy-all=true 但无任何 socks5 配置 → 零拨号直接 CLOSE，不得偷跑直连", async () => {
      setPolicy(() => "open"); // 直连本可成功，也要 fail-close
      const { server } = await openSession(worker, { query: "?proxy-all=true" });
      await server.fromClient(connectFrame(3, "direct.example", 443));
      await waitFor(() => server.typesOf(3).includes(T.CLOSE), { label: "CLOSE" });
      assert.equal(sockets().length, 0, "无 socks5 配置不得回退直连");
    });

    test("proxy-all=true 不受 ENABLE_FALLBACK=false 影响（socks5 不是 L4 回退链）", async () => {
      setPolicy((opts) => (opts.hostname === "p.example" ? "open" : "reject"));
      const { server } = await openSession(worker, {
        query: "?fallbackip=p.example:1080&proxy-all=true",
        envVars: { ENABLE_FALLBACK: "false" },
      });
      await server.fromClient(connectFrame(4, "example.com", 443));
      await waitFor(() => sockets().length >= 1, { label: "拨 socks5" });
      const hs = await socks5Server(sockets()[0]);
      await waitFor(() => server.typesOf(4).includes(T.CONNECTED), { label: "CONNECTED" });
      assert.equal(hs.connect.addr, "example.com", "ENABLE_FALLBACK 不拦截 socks5 出口");
    });

    test("?proxy-all= 真值集合：1/yes/on 生效走 socks5，缺省与假值保持直连优先", async () => {
      for (const v of ["1", "yes", "on", "TRUE"]) {
        resetStub();
        setPolicy((opts) => (opts.hostname === "p.example" ? "open" : "reject"));
        const { server } = await openSession(worker, { query: `?fallbackip=p.example:1080&proxy-all=${v}` });
        await server.fromClient(connectFrame(1, "example.com", 443));
        await waitFor(() => sockets().length >= 1, { label: `proxy-all=${v} 拨 socks5` });
        await socks5Server(sockets()[0]);
        await waitFor(() => server.typesOf(1).includes(T.CONNECTED), { label: `CONNECTED ${v}` });
        assert.deepEqual(sockets().map((s) => s.opts.hostname), ["p.example"], `${v} 应走 socks5`);
      }
      for (const q of ["", "&proxy-all=false", "&proxy-all=0", "&proxy-all=nope"]) {
        resetStub();
        setPolicy(() => "open");
        const { server } = await openSession(worker, { query: `?fallbackip=q.example${q}` });
        await server.fromClient(connectFrame(1, "direct.example", 443));
        await waitFor(() => server.typesOf(1).includes(T.CONNECTED), { label: `缺省(${q}) 直连成功` });
        assert.deepEqual(
          sockets().map((s) => s.opts.hostname),
          ["direct.example"],
          `缺省/假值(${q}) 必须保持直连优先`,
        );
      }
    });

    test("对不存在的 streamId 发 DATA/CLOSE：零回帧且不占槽位", async () => {
      const { server } = await openSession(worker, { envVars: { MAX_STREAMS_PER_CONNECTION: "1" } });
      const before = server.sent.length;
      await server.fromClient(frame(77, T.DATA, "x"));
      await server.fromClient(frame(78, T.CLOSE));
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(server.sent.length, before, `不存在的流不应有回帧（frames: ${JSON.stringify(server.frames().slice(before))}）`);
      assert.equal(server.closed, null, "不应拆会话");
      // 槽位没被占：仍能建流
      await server.fromClient(connectFrame(1, "a.example", 443));
      await waitFor(() => server.typesOf(1).includes(T.CONNECTED), { label: "槽位未被占用" });
    });

    test("streamId 0 与 255 端到端可用（客户端首个流号就是 0）", async () => {
      const { server } = await openSession(worker);
      for (const id of [0, 255]) {
        await server.fromClient(connectFrame(id, `h${id}.example`, 443));
        await waitFor(() => server.typesOf(id).includes(T.CONNECTED), { label: `streamId ${id} CONNECTED` });
        await server.fromClient(frame(id, T.DATA, `d${id}`));
        await waitFor(() => sockets()[id === 0 ? 0 : 1].toTarget.length === 1, { label: `streamId ${id} DATA` });
      }
    });

    test("WebSocket error 事件：回收所有流并关闭会话", async () => {
      const { server } = await openSession(worker);
      await server.fromClient(connectFrame(1, "a.example", 443));
      await waitFor(() => server.typesOf(1).includes(T.CONNECTED), { label: "CONNECTED" });
      server.emitError("unexpected transport error");
      await waitFor(() => sockets()[0].closed, { label: "socket 回收" });
      assert.ok(server.closed, "error 后应关闭 WebSocket");
    });

    test("连接超时会回收 socket 并转试下一个出口", async () => {
      setPolicy((opts) => (opts.hostname === "direct.example" ? "hang" : "open"));
      const { server } = await openSession(worker, {
        envVars: { CONNECT_TIMEOUT: "100", FALLBACK_IPS: "backup.example" },
      });
      await server.fromClient(connectFrame(3, "direct.example", 443));
      await waitFor(() => server.typesOf(3).includes(T.CONNECTED), { label: "回退成功" });

      const list = sockets();
      assert.equal(list.length, 2, "应先试直连再试静态回退");
      assert.equal(list[0].opts.hostname, "direct.example");
      assert.equal(list[0].closed, true, "超时的 socket 必须被 close 回收（回归：曾泄漏到 isolate 结束）");
      assert.equal(list[1].opts.hostname, "backup.example");
      assert.equal(list[1].closed, false);
    });

    test("目标地址非法时关流且不发起任何连接", async () => {
      const { server } = await openSession(worker, { envVars: { FALLBACK_IPS: "b1.example,b2.example" } });
      await server.fromClient(frame(1, T.CONNECT, "example.com:notaport|"));
      await server.fromClient(frame(1, T.CONNECT, "|"));
      await server.fromClient(frame(1, T.CONNECT, "example.com:70000|"));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(sockets().length, 0, "非法目标不应触发任何 connect（回归：曾带 NaN 端口跑遍回退列表）");
      // 后续合法流仍可用，说明只是关流而非拆会话
      await server.fromClient(connectFrame(1, "ok.example", 443));
      await waitFor(() => server.typesOf(1).includes(T.CONNECTED), { label: "合法流仍可用" });
    });

    test("CONNECT 负载缺尾杠 | 时按整串解析（容忍非本仓客户端）", async () => {
      const { server } = await openSession(worker);
      await server.fromClient(frame(4, T.CONNECT, "example.com:443"));
      await waitFor(() => server.typesOf(4).includes(T.CONNECTED), { label: "CONNECTED" });
      assert.deepEqual(sockets()[0].opts, { hostname: "example.com", port: 443 });
    });

    test("全部出口失败时向客户端回 CLOSE（快速失败，不等客户端超时）", async () => {
      setPolicy(() => "reject");
      const { server } = await openSession(worker, { envVars: { FALLBACK_IPS: "b1.example,b2.example" } });
      await server.fromClient(connectFrame(5, "nope.example", 443));
      await waitFor(() => server.typesOf(5).includes(T.CLOSE), { label: "失败后 CLOSE" });
      assert.equal(sockets().length, 3, "直连 + 2 个静态回退各试一次");
      assert.ok(sockets().every((s) => s.closed), "被拒的 socket 也要回收");
      // 失败后同一会话的其他流仍可用
      setPolicy(() => "open");
      await server.fromClient(connectFrame(6, "ok.example", 443));
      await waitFor(() => server.typesOf(6).includes(T.CONNECTED), { label: "后续流可用" });
    });

    test("目标地址非法时向客户端回 CLOSE", async () => {
      const { server } = await openSession(worker);
      await server.fromClient(frame(1, T.CONNECT, "example.com:notaport|"));
      await waitFor(() => server.typesOf(1).includes(T.CLOSE), { label: "非法目标 CLOSE" });
    });

    test("flush 期间流被换掉：旧代不再发 CONNECTED（回归：flush 窗口的双 CONNECTED）", async () => {
      // 把写挂起，模拟"早期负载已下到 TCP 缓冲、write 正在结算"的窗口。
      // 真实运行时 socket 被 close 后在途 write 可能仍兑现，故替身不复现在途写失败。
      const gates = [];
      setWriteHook(() => new Promise((res) => gates.push(res)));
      try {
        setPolicy((opts) => (opts.hostname === "slow.example" ? "hang" : "open"));
        const { server } = await openSession(worker, { envVars: { CONNECT_TIMEOUT: "30000" } });
        await server.fromClient(connectFrame(7, "slow.example", 443));
        await server.fromClient(frame(7, T.DATA, "early"));
        const sockA = sockets()[0];
        sockA.resolveOpened();
        await waitFor(() => gates.length >= 1, { label: "旧代 flush 写入挂起" });

        // 窗口内：同一 streamId 重发 CONNECT → 旧代被换掉
        await server.fromClient(connectFrame(7, "fast.example", 443));
        await waitFor(() => server.typesOf(7).filter((t) => t === T.CONNECTED).length === 1, { label: "新代 CONNECTED" });

        gates.forEach((g) => g()); // 放行旧代 flush
        await new Promise((r) => setTimeout(r, 30));

        assert.equal(sockA.closed, true, "旧代 socket 应被回收");
        assert.equal(
          server.typesOf(7).filter((t) => t === T.CONNECTED).length,
          1,
          "旧代不得在 flush 之后补发第二帧 CONNECTED",
        );
      } finally {
        setWriteHook(null);
      }
    });

    test("flush 期间客户端 CLOSE：不再收到 CONNECTED", async () => {
      const gates = [];
      setWriteHook(() => new Promise((res) => gates.push(res)));
      try {
        setPolicy(() => "hang");
        const { server } = await openSession(worker, { envVars: { CONNECT_TIMEOUT: "30000" } });
        await server.fromClient(connectFrame(5, "slow.example", 443));
        await server.fromClient(frame(5, T.DATA, "early"));
        sockets()[0].resolveOpened();
        await waitFor(() => gates.length >= 1, { label: "flush 写入挂起" });
        await server.fromClient(frame(5, T.CLOSE));
        gates.forEach((g) => g());
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(server.typesOf(5).includes(T.CONNECTED), false, `流已被关，不应再收到 CONNECTED（frames: ${JSON.stringify(server.typesOf(5))}）`);
      } finally {
        setWriteHook(null);
      }
    });

    test("文本（非二进制）WebSocket 消息被忽略，不拆会话", async () => {
      const { server } = await openSession(worker);
      // 真实 WebSocket 文本帧的 event.data 是 string
      server.deliverText("\u0000\u0000hello");
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(server.closed, null, "文本帧不得拆掉整条会话");
      await server.fromClient(connectFrame(1, "a.example", 443));
      await waitFor(() => server.typesOf(1).includes(T.CONNECTED), { label: "会话仍可用" });
    });

    test("USER_ID 大小写：客户端路径与 env 一致即可（大小写不敏感）", async () => {
      const { res } = await openSession(worker, { envVars: { USER_ID: "AbC" }, path: "/abc" });
      assert.equal(res.status, 101);
    });

    test("重复 CONNECT 同一 streamId 会关旧流重建", async () => {
      const { server } = await openSession(worker);
      await server.fromClient(connectFrame(9, "a.example", 443));
      await waitFor(() => server.typesOf(9).includes(T.CONNECTED), { label: "首个 CONNECTED" });
      await server.fromClient(connectFrame(9, "b.example", 443));
      await waitFor(() => sockets().length === 2, { label: "第二个 socket" });
      assert.equal(sockets()[0].closed, true, "旧流 socket 应被关闭");
      assert.equal(sockets()[1].opts.hostname, "b.example");
    });

    test("重复 CONNECT 并发：在途旧拨号不会绑到新流（回归：双 CONNECTED + socket 泄漏）", async () => {
      // 第一次 CONNECT 拨号挂起，客户端不等 CONNECTED 就用同一 streamId 再发 CONNECT
      setPolicy((opts) => (opts.hostname === "slow.example" ? "hang" : "open"));
      const { server } = await openSession(worker, { envVars: { CONNECT_TIMEOUT: "30000" } });
      await server.fromClient(connectFrame(5, "slow.example", 443));
      await waitFor(() => sockets().length === 1, { label: "首个 socket 在途" });
      await server.fromClient(connectFrame(5, "fast.example", 443));
      await waitFor(() => server.typesOf(5).includes(T.CONNECTED), { label: "新流 CONNECTED" });

      // 旧拨号此刻才迟到兑现
      sockets()[0].resolveOpened();
      await new Promise((r) => setTimeout(r, 30));

      assert.equal(sockets()[0].closed, true, "迟到 socket 必须被回收（回归：曾泄漏到 isolate 结束）");
      assert.equal(sockets()[1].closed, false, "新流的 socket 不该被旧链关掉");
      assert.equal(
        server.typesOf(5).filter((t) => t === T.CONNECTED).length,
        1,
        "同一 streamId 只应有一个 CONNECTED（回归：曾双发）",
      );
    });

    test("旧 pump 收尾不会判死同 id 的新流（回归：杂散 CLOSE 杀死健康流）", async () => {
      const { server } = await openSession(worker);
      await server.fromClient(connectFrame(4, "a.example", 443));
      await waitFor(() => server.typesOf(4).includes(T.CONNECTED), { label: "A CONNECTED" });
      const sockA = sockets()[0];
      // 同 id 重建新流
      await server.fromClient(connectFrame(4, "b.example", 443));
      await waitFor(() => sockets().length === 2, { label: "B socket" });
      assert.equal(sockA.closed, true, "A 的 socket 已关");

      // A 的 pump 因 releaseLock 结算，尝试收尾；它不得发 CLOSE 打死 B
      const before = server.typesOf(4).length;
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(sockA.closed, true);
      assert.equal(sockets()[1].closed, false, "B 的 socket 不该被 A 的 pump 收尾关掉");
      const after = server.typesOf(4);
      assert.equal(after.filter((t) => t === T.CLOSE).length, 0, `旧 pump 不得发 CLOSE（frames: ${JSON.stringify(after.slice(before))}）`);
    });

    test("流被客户端 CLOSE 后不再继续拨打剩余回退出口（回归：会话已死仍耗尽回退链）", async () => {
      setPolicy(() => "hang");
      const { server } = await openSession(worker, {
        envVars: { CONNECT_TIMEOUT: "30000", FALLBACK_IPS: "b1.example,b2.example,b3.example" },
      });
      await server.fromClient(connectFrame(1, "direct.example", 443));
      await waitFor(() => sockets().length === 1, { label: "首个在途 socket" });
      await server.fromClient(frame(1, T.CLOSE));
      // 让第一条拨号链此刻失败：修复后应停手，修复前会接着把 b1..b3 全拨一遍
      sockets()[0].rejectOpened(new Error("refused"));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(sockets().length, 1, `流已关闭却还在拨号（回归：曾拨满整条回退链），实际 ${JSON.stringify(sockets().map((s) => s.opts.hostname))}`);
    });

    test("超过 MAX_STREAMS_PER_CONNECTION 直接回 CLOSE", async () => {
      const { server } = await openSession(worker, { envVars: { MAX_STREAMS_PER_CONNECTION: "1" } });
      await server.fromClient(connectFrame(1, "a.example", 443));
      await waitFor(() => server.typesOf(1).includes(T.CONNECTED), { label: "首个流" });
      await server.fromClient(connectFrame(2, "b.example", 443));
      await waitFor(() => server.typesOf(2).includes(T.CLOSE), { label: "超限 CLOSE" });
      assert.equal(sockets().length, 1, "超限的流不应发起连接");
    });

    test("客户端 CLOSE 关闭对应流", async () => {
      const { server } = await openSession(worker);
      await server.fromClient(connectFrame(4, "a.example", 443));
      await waitFor(() => server.typesOf(4).includes(T.CONNECTED));
      await server.fromClient(frame(4, T.CLOSE));
      await waitFor(() => sockets()[0].closed, { label: "socket 关闭" });
    });

    test("重复 CONNECT 用例补断言：新流确实拿到 CONNECTED 且 socket 未被旧链误关", async () => {
      const { server } = await openSession(worker);
      await server.fromClient(connectFrame(9, "a.example", 443));
      await waitFor(() => server.typesOf(9).includes(T.CONNECTED));
      await server.fromClient(connectFrame(9, "b.example", 443));
      await waitFor(() => server.typesOf(9).filter((t) => t === T.CONNECTED).length === 2);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sockets()[1].closed, false, "新流 socket 不应被旧链收尾关掉");
    });

    test("短包与未知类型只记日志、不拆会话", async () => {
      const { server } = await openSession(worker);
      await server.fromClient(new Uint8Array([1]));
      await server.fromClient(frame(1, 99, "weird"));
      await server.fromClient(connectFrame(1, "a.example", 443));
      await waitFor(() => server.typesOf(1).includes(T.CONNECTED), { label: "会话仍可用" });
      assert.equal(server.closed, null);
    });

    test("回退项与直连 host 相同不重复拨号（跨列表去重）", async () => {
      setPolicy(() => "reject");
      const { server } = await openSession(worker, {
        query: "?fallbackip=direct.example",
        envVars: { FALLBACK_IPS: "DIRECT.EXAMPLE:443" },
      });
      await server.fromClient(connectFrame(8, "direct.example", 443));
      await waitFor(() => server.typesOf(8).includes(T.CLOSE), { label: "全败 CLOSE" });
      assert.equal(sockets().length, 1, `与直连相同的回退项被重复拨了（回归）：${JSON.stringify(sockets().map((s) => s.opts.hostname))}`);
    });

    test("ENABLE_FALLBACK=false 时不走任何回退出口", async () => {
      setPolicy(() => "reject");
      const { server } = await openSession(worker, {
        envVars: { ENABLE_FALLBACK: "false", FALLBACK_IPS: "b1.example", DYNAMIC_NODES_URL: "https://nodes.example/api" },
      });
      await server.fromClient(connectFrame(2, "direct.example", 443));
      await waitFor(() => server.typesOf(2).includes(T.CLOSE), { label: "直连失败即 CLOSE" });
      assert.equal(sockets().length, 1, `ENABLE_FALLBACK=false 仍拨了回退：${JSON.stringify(sockets().map((s) => s.opts.hostname))}`);
    });

    test("ENABLE_DYNAMIC_NODES=false 时不外呼动态节点 API", async () => {
      let fetched = 0;
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        fetched++;
        return { ok: true, status: 200, json: async () => ({ nodes: [{ ip: "1.2.3.4" }] }) };
      };
      try {
        setPolicy(() => "reject");
        const { server } = await openSession(worker, {
          envVars: { ENABLE_DYNAMIC_NODES: "false", DYNAMIC_NODES_URL: "https://nodes.example/api" },
        });
        await server.fromClient(connectFrame(2, "direct.example", 443));
        await waitFor(() => server.typesOf(2).includes(T.CLOSE), { label: "直连失败即 CLOSE" });
        assert.equal(fetched, 0, "ENABLE_DYNAMIC_NODES=false 仍外呼了 API");
        assert.equal(sockets().length, 1);
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    test("流槽位在关闭后释放：顺序建流超过 MAX_STREAMS 仍能继续", async () => {
      const { server } = await openSession(worker, { envVars: { MAX_STREAMS_PER_CONNECTION: "2" } });
      for (const id of [1, 2]) {
        await server.fromClient(connectFrame(id, `h${id}.example`, 443));
        await waitFor(() => server.typesOf(id).includes(T.CONNECTED), { label: `流 ${id} CONNECTED` });
      }
      // 两条流依次被远端 EOF 结束（最常见的流终止路径）
      for (const id of [1, 2]) {
        sockets()[id - 1].eofToClient();
        await waitFor(() => server.typesOf(id).includes(T.CLOSE), { label: `流 ${id} CLOSE` });
      }
      await new Promise((r) => setTimeout(r, 10));
      await server.fromClient(connectFrame(3, "h3.example", 443));
      await waitFor(() => server.typesOf(3).includes(T.CONNECTED), { label: "第三条流仍可建（槽位已回收）" });
    });

    test("写失败回 CLOSE 并回收流与 socket", async () => {
      setWriteHook(() => {
        throw new Error("write failed (RST)");
      });
      try {
        const { server } = await openSession(worker);
        await server.fromClient(connectFrame(6, "a.example", 443));
        await waitFor(() => server.typesOf(6).includes(T.CONNECTED), { label: "CONNECTED" });
        await server.fromClient(frame(6, T.DATA, "payload"));
        await waitFor(() => server.typesOf(6).includes(T.CLOSE), { label: "写失败后 CLOSE" });
        assert.equal(sockets()[0].closed, true, "socket 应被回收");
        // 槽位已释放，同一会话可继续建流
        setWriteHook(null);
        await server.fromClient(connectFrame(7, "b.example", 443));
        await waitFor(() => server.typesOf(7).includes(T.CONNECTED), { label: "后续流可用" });
      } finally {
        setWriteHook(null);
      }
    });

    test("读异常：转发中断后回 CLOSE 并回收流", async () => {
      const { server } = await openSession(worker);
      await server.fromClient(connectFrame(6, "a.example", 443));
      await waitFor(() => server.typesOf(6).includes(T.CONNECTED), { label: "CONNECTED" });
      sockets()[0].failToClient(new Error("read reset"));
      await waitFor(() => server.typesOf(6).includes(T.CLOSE), { label: "读异常后 CLOSE" });
      assert.equal(sockets()[0].closed, true, "socket 应被回收");
    });

    test("CONNECTED / CLOSE 帧严格 2 字节（协议铁律）", async () => {
      const { server } = await openSession(worker);
      await server.fromClient(connectFrame(1, "a.example", 443));
      await waitFor(() => server.typesOf(1).includes(T.CONNECTED), { label: "CONNECTED" });
      const sock = sockets()[0];
      sock.eofToClient();
      await waitFor(() => server.typesOf(1).includes(T.CLOSE), { label: "CLOSE" });
      for (const f of server.sent) {
        if (f[1] === T.CONNECTED || f[1] === T.CLOSE) {
          assert.equal(f.length, 2, `${f[1] === T.CONNECTED ? "CONNECTED" : "CLOSE"} 帧多出 ${f.length - 2} 字节负载`);
        }
      }
      assert.equal(sockets()[0].closed, true, "EOF 后流必须被清理（槽位回收）");
    });

    test("flush 写失败：回 CLOSE（回归：客户端无任何回帧只能等超时）", async () => {
      let failNext = true;
      setWriteHook(() => {
        if (failNext) {
          failNext = false;
          throw new Error("flush write failed");
        }
      });
      try {
        setPolicy(() => "hang");
        const { server } = await openSession(worker, { envVars: { CONNECT_TIMEOUT: "30000" } });
        await server.fromClient(connectFrame(3, "slow.example", 443));
        await server.fromClient(frame(3, T.DATA, "early"));
        const sock = sockets()[0];
        sock.resolveOpened();
        await waitFor(() => server.typesOf(3).includes(T.CLOSE), { label: "flush 失败后 CLOSE" });
        assert.equal(sock.closed, true, "socket 应被回收");
      } finally {
        setWriteHook(null);
      }
    });

    test("空 DATA 帧不能零成本绕过早期数据上限（回归：payload 0 字节不计费）", async () => {
      setPolicy(() => "hang");
      const { server } = await openSession(worker, {
        envVars: { CONNECT_TIMEOUT: "30000", MAX_PENDING_BYTES: "16384" },
      });
      await server.fromClient(connectFrame(4, "slow.example", 443));
      for (let i = 0; i < 600; i++) await server.fromClient(frame(4, T.DATA)); // 空帧
      await waitFor(() => server.typesOf(4).includes(T.CLOSE), { label: "空帧超限 CLOSE" });
    });

    test("USER_ID 含大写：客户端原样传 /AbC 也应握手成功", async () => {
      const { res } = await openSession(worker, { envVars: { USER_ID: "AbCdEf" }, path: "/AbCdEf" });
      assert.equal(res.status, 101, "混合大小写 USER_ID 不得永远 403（回归）");
    });

    test("在途未确认写出超上限：回 CLOSE 并关流（回归：慢目标时写出队列无界）", async () => {
      // 目标永不读：写全部挂起
      const gates = [];
      setWriteHook(() => new Promise((res) => gates.push(res)));
      try {
        const { server } = await openSession(worker, { envVars: { MAX_PENDING_BYTES: "16384" } });
        await server.fromClient(connectFrame(4, "a.example", 443));
        await waitFor(() => server.typesOf(4).includes(T.CONNECTED), { label: "CONNECTED" });
        for (let i = 0; i < 200; i++) {
          await server.fromClient(frame(4, T.DATA, new Uint8Array(1024))); // 每帧计入 1024+32
        }
        await waitFor(() => server.typesOf(4).includes(T.CLOSE), { label: "在途超限 CLOSE" });
        assert.equal(sockets()[0].closed, true, "socket 应被回收");
      } finally {
        setWriteHook(null);
      }
    });

    test("客户端主动 CLOSE 后服务端不回帧（回归：杂散 CLOSE 打断同 id 复用）", async () => {
      const { server } = await openSession(worker);
      await server.fromClient(connectFrame(4, "a.example", 443));
      await waitFor(() => server.typesOf(4).includes(T.CONNECTED), { label: "CONNECTED" });
      const before = server.typesOf(4).length;
      await server.fromClient(frame(4, T.CLOSE));
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(server.typesOf(4).slice(before), [], `客户端已关流，服务端不应再回帧（实际 ${JSON.stringify(server.typesOf(4).slice(before))}）`);
      assert.equal(sockets()[0].closed, true);
    });

    test("日志净化：客户端可控内容里的控制字符被替换", async () => {
      const { cleanLog } = await loadInternals();
      assert.equal(cleanLog("a\nb"), "a b");
      const esc = String.fromCharCode(27);
      assert.equal(cleanLog(`[Mux] ${esc}[31m伪造`), "[Mux]  [31m伪造");
      assert.equal(cleanLog("x".repeat(500)).length, 200, "超长内容应被截断");
    });

    test("动态节点拉取失败：负缓存窗口内不再重复外呼（回归：每条流空等一次超时）", async () => {
      let calls = 0;
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        calls++;
        throw new Error("network down");
      };
      try {
        setPolicy(() => "reject");
        const w = await freshWorker(worker === workers.min ? "min" : "dev");
        let s = await openSession(w, { envVars: { DYNAMIC_NODES_URL: "https://nodes.example/api" } });
        await s.server.fromClient(connectFrame(1, "a.example", 443));
        await waitFor(() => s.server.typesOf(1).includes(T.CLOSE), { label: "首条流结束" });
        s.server.close();
        resetStub();
        assert.equal(calls, 1, "首次拉取应发生一次");

        // 第二条流：仍在负缓存窗口内，不应再外呼
        setPolicy(() => "reject");
        s = await openSession(w, { envVars: { DYNAMIC_NODES_URL: "https://nodes.example/api" } });
        await s.server.fromClient(connectFrame(2, "b.example", 443));
        await waitFor(() => s.server.typesOf(2).includes(T.CLOSE), { label: "第二条流结束" });
        assert.equal(calls, 1, `负缓存窗口内不应重复外呼，实际外呼 ${calls} 次`);
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    test("?fallbackip= 逐个尝试并去重", async () => {
      setPolicy((opts) => (opts.hostname === "dup.example" ? "open" : "reject"));
      const { server } = await openSession(worker, {
        query: "?fallbackip=bad.example,dup.example&fallbackip=DUP.example",
      });
      await server.fromClient(connectFrame(2, "direct.example", 443));
      await waitFor(() => server.typesOf(2).includes(T.CONNECTED), { label: "客户端回退成功" });
      assert.deepEqual(
        sockets().map((s) => s.opts.hostname),
        ["direct.example", "bad.example", "dup.example"],
        "期望：直连 → query 回退依次尝试，大小写重复项去重",
      );
    });

    test("动态节点 API 提供回退（fetch 拉取 + 去重 + 上限）", async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          nodes: [
            { ip: "1.1.1.1" },
            { ip: "1.1.1.1" }, // 重复 → 去重
            { host: "2606:4700::1", port: "8443" }, // 裸 IPv6 → 自动加方括号
            { ip: "9.9.9.9", port: "99999" }, // 端口越界 → 丢弃
            { ip: "8.8.8.8" },
          ],
        }),
      });
      try {
        setPolicy(() => "reject");
        const w = await freshWorker(worker === workers.min ? "min" : "dev");
        const { server } = await openSession(w, {
          envVars: { DYNAMIC_NODES_URL: "https://nodes.example/api" },
        });
        await server.fromClient(connectFrame(6, "direct.example", 443));
        await waitFor(() => sockets().length >= 2, { label: "至少一次回退尝试" });
        const hosts = sockets().map((s) => `${s.opts.hostname}:${s.opts.port}`);
        assert.ok(hosts.includes("1.1.1.1:443"), `期望继承目标端口，实际 ${hosts}`);
        assert.ok(hosts.includes("2606:4700::1:8443"), `期望裸 IPv6+端口被正确解析，实际 ${hosts}`);
        assert.ok(!hosts.some((h) => h.startsWith("9.9.9.9")), `非法端口条目应被丢弃，实际 ${hosts}`);
        assert.equal(hosts.filter((h) => h === "1.1.1.1:443").length, 1, "重复节点应去重");
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    // 以下两条用 freshWorker：worker.js 有模块级 dynamicNodesCache（stale 降级），
    // 共用实例会让用例互相污染（评审 F20：曾出现"名为降级为空、实际走 stale"的假绿）
    test("动态节点拉取失败（无 stale）降级为空并继续静态回退", async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        throw new Error("network down");
      };
      try {
        setPolicy((opts) => (opts.hostname === "static.example" ? "open" : "reject"));
        const w = await freshWorker(worker === workers.min ? "min" : "dev");
        const { server } = await openSession(w, {
          envVars: { DYNAMIC_NODES_URL: "https://nodes.example/api", FALLBACK_IPS: "static.example" },
        });
        await server.fromClient(connectFrame(8, "direct.example", 443));
        await waitFor(() => server.typesOf(8).includes(T.CONNECTED), { label: "静态回退成功" });
        const tried = sockets().map((s) => s.opts.hostname);
        assert.deepEqual(tried, ["direct.example", "static.example"], "拉取失败且无 stale 时不得有任何动态节点被拨");
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    test("动态节点拉取失败时复用上次的 stale 列表（有意行为）", async () => {
      const realFetch = globalThis.fetch;
      let mode = "ok";
      globalThis.fetch = async () => {
        if (mode === "fail") throw new Error("network down");
        return { ok: true, status: 200, json: async () => ({ nodes: [{ ip: "stale.example" }] }) };
      };
      try {
        // 第一次：API 正常，拿到 stale.example
        setPolicy((opts) => (opts.hostname === "stale.example" ? "open" : "reject"));
        const w = await freshWorker(worker === workers.min ? "min" : "dev");
        let s = await openSession(w, { envVars: { DYNAMIC_NODES_URL: "https://nodes.example/api" } });
        await s.server.fromClient(connectFrame(1, "direct.example", 443));
        await waitFor(() => s.server.typesOf(1).includes(T.CONNECTED), { label: "动态节点接通" });
        s.server.close();
        resetStub();

        // 第二次：API 故障，同一模块实例应复用 stale 列表
        mode = "fail";
        setPolicy((opts) => (opts.hostname === "stale.example" ? "open" : "reject"));
        s = await openSession(w, { envVars: { DYNAMIC_NODES_URL: "https://nodes.example/api" } });
        await s.server.fromClient(connectFrame(2, "direct.example", 443));
        await waitFor(() => s.server.typesOf(2).includes(T.CONNECTED), { label: "stale 回退接通" });
        assert.equal(sockets()[1].opts.hostname, "stale.example", "API 故障时应复用 stale 列表");
      } finally {
        globalThis.fetch = realFetch;
      }
    });

    test("WebSocket 关闭时回收所有流", async () => {
      const { server } = await openSession(worker);
      await server.fromClient(connectFrame(1, "a.example", 443));
      await server.fromClient(connectFrame(2, "b.example", 443));
      await waitFor(() => sockets().length === 2);
      server.close(1000, "client gone");
      await waitFor(() => sockets().every((s) => s.closed), { label: "全部 socket 回收" });
    });

    test("未配置 USER_ID：fail-closed，任何路径都拒绝（回归：曾退到公开占位路径）", async () => {
      for (const envVars of [{}, { USER_ID: "" }, { USER_ID: "   " }, { USER_ID: undefined }]) {
        for (const path of ["/uuid-placeholder", "/anything", "/"]) {
          const res = await worker.fetch(
            { url: `https://worker.test${path}`, headers: { get: () => "websocket" } },
            { CONNECT_TIMEOUT: "1000", ...envVars },
          );
          assert.equal(res.status, 403, `env=${JSON.stringify(envVars)} path=${path} 应拒绝`);
          assert.match(await res.text(), /not allowed/i);
        }
      }
    });

    test("USER_ID 前后空白被忽略，不影响鉴权", async () => {
      const { res } = await openSession(worker, { envVars: { USER_ID: "  padded-id  " }, path: "/padded-id" });
      assert.equal(res.status, 101);
    });

    test("异常 env 不致命（fetch 内部抛错返回 500）", async () => {
      const res = await worker.fetch(
        { url: "not-a-url", headers: { get: () => "websocket" } },
        env(),
      );
      assert.equal(res.status, 500);
    });
  });
}
