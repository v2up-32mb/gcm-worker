// worker.js 行为用例：同一套用例同时跑在「可读版」与「压缩版(Snippets)」产物上，
// 任何行为差异都会让测试失败——这是压缩版可发布的前提。
//
// 跑法：npm test

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  loadWorkers, openSession, connectFrame, frame, T, waitFor, sockets, resetStub, env,
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
    `${body}\nreturn { parseAddress, parseFallbackEntry, normalizeNodeEntry, buildConfigFromEnv, parseEnvBool, parseEnvInt };`,
  );
  return fn();
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
  });

  test("buildConfigFromEnv 解析布尔/整数并做范围钳制", () => {
    const c = internals.buildConfigFromEnv;
    const dflt = c({});
    assert.equal(dflt.enableFallback, true);
    assert.equal(dflt.connectTimeout, 1000);
    assert.equal(dflt.maxStreamsPerConnection, 16);
    assert.equal(dflt.dynamicNodesUrl, "");

    const custom = c({
      ENABLE_FALLBACK: "off",
      CONNECT_TIMEOUT: "50", // 低于 min=100 → 回退默认
      MAX_STREAMS_PER_CONNECTION: "999", // 高于 max=256 → 回退默认
      DYNAMIC_NODES_URL: " https://nodes.example/api ",
    });
    assert.equal(custom.enableFallback, false);
    assert.equal(custom.connectTimeout, 1000);
    assert.equal(custom.maxStreamsPerConnection, 16);
    assert.equal(custom.dynamicNodesUrl, "https://nodes.example/api");

    assert.equal(c({ ENABLE_LOGGING: "1" }).enableLogging, true);
    assert.equal(c({ ENABLE_LOGGING: "yes" }).enableLogging, true);
    assert.equal(c({ ENABLE_LOGGING: "nope" }).enableLogging, false, "无法识别的值回退默认");
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
      globalThis.__CF_STUB__ = undefined;
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

    test("TCP 未连上时的早期 DATA 被缓存并在连上后 flush", async () => {
      globalThis.__CF_STUB__ = { sockets: [], policy: () => "hang", reset() {} };
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

    test("连接超时会回收 socket 并转试下一个出口", async () => {
      globalThis.__CF_STUB__ = {
        sockets: [],
        reset() {},
        policy: (opts) => (opts.hostname === "direct.example" ? "hang" : "open"),
      };
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

    test("重复 CONNECT 同一 streamId 会关旧流重建", async () => {
      const { server } = await openSession(worker);
      await server.fromClient(connectFrame(9, "a.example", 443));
      await waitFor(() => server.typesOf(9).includes(T.CONNECTED), { label: "首个 CONNECTED" });
      await server.fromClient(connectFrame(9, "b.example", 443));
      await waitFor(() => sockets().length === 2, { label: "第二个 socket" });
      assert.equal(sockets()[0].closed, true, "旧流 socket 应被关闭");
      assert.equal(sockets()[1].opts.hostname, "b.example");
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

    test("短包与未知类型只记日志、不拆会话", async () => {
      const { server } = await openSession(worker);
      await server.fromClient(new Uint8Array([1]));
      await server.fromClient(frame(1, 99, "weird"));
      await server.fromClient(connectFrame(1, "a.example", 443));
      await waitFor(() => server.typesOf(1).includes(T.CONNECTED), { label: "会话仍可用" });
      assert.equal(server.closed, null);
    });

    test("?fallbackip= 逐个尝试并去重", async () => {
      globalThis.__CF_STUB__ = {
        sockets: [],
        reset() {},
        policy: (opts) => (opts.hostname === "dup.example" ? "open" : "reject"),
      };
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
        globalThis.__CF_STUB__ = { sockets: [], reset() {}, policy: () => "reject" };
        const { server } = await openSession(worker, {
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

    test("动态节点拉取失败时降级为空并继续静态回退", async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        throw new Error("network down");
      };
      try {
        globalThis.__CF_STUB__ = {
          sockets: [],
          reset() {},
          policy: (opts) => (opts.hostname === "static.example" ? "open" : "reject"),
        };
        const { server } = await openSession(worker, {
          envVars: { DYNAMIC_NODES_URL: "https://nodes.example/api", FALLBACK_IPS: "static.example" },
        });
        await server.fromClient(connectFrame(8, "direct.example", 443));
        await waitFor(() => server.typesOf(8).includes(T.CONNECTED), { label: "静态回退成功" });
        assert.equal(sockets().at(-1).opts.hostname, "static.example");
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

    test("缺少 USER_ID 时使用弱保护占位路径", async () => {
      const request = {
        url: "https://worker.test/uuid-placeholder",
        headers: { get: () => "websocket" },
      };
      const res = await worker.fetch(request, { CONNECT_TIMEOUT: "1000" });
      assert.equal(res.status, 101);
      const bad = await worker.fetch(
        { url: "https://worker.test/anything", headers: { get: () => "websocket" } },
        {},
      );
      assert.equal(bad.status, 403);
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
