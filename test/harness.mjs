// 测试台：把 worker.js 打成 Node 可加载的 ESM，装上 Workers 运行时替身
// （Response/WebSocketPair/connect），并提供会话驱动与断言辅助。

import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { buildTestable, REPO_ROOT } from "../scripts/build.mjs";

const TMP = join(REPO_ROOT, "test/.tmp");

let cached = null;

/** 构建并加载可读版 + 压缩版 worker 模块（同一份源码的两种产物） */
export async function loadWorkers() {
  if (cached) return cached;
  const dev = await buildTestable({ outfile: join(TMP, "worker.dev.mjs"), minify: false });
  const min = await buildTestable({ outfile: join(TMP, "worker.min.mjs"), minify: true });
  const devMod = await import(pathToFileURL(dev).href);
  const minMod = await import(pathToFileURL(min).href);
  cached = { dev: devMod.default, min: minMod.default, devFile: dev, minFile: min };
  return cached;
}

// ---------- Workers 运行时替身 ----------

class FakeResponse {
  constructor(body = null, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.headers = init.headers ?? {};
    this.webSocket = init.webSocket; // 仅 101 握手用
  }
  async text() {
    return typeof this.body === "string" ? this.body : String(this.body ?? "");
  }
}

/** 服务端一侧的 WebSocket：记录发出的帧、接收客户端消息 */
class FakeWS {
  constructor(name) {
    this.name = name;
    this.readyState = 1; // OPEN
    this.sent = []; // 服务端 → 客户端
    this.accepted = false;
    this.closed = null;
    this._ls = new Map();
  }
  accept() {
    this.accepted = true;
  }
  addEventListener(type, fn) {
    if (!this._ls.has(type)) this._ls.set(type, []);
    this._ls.get(type).push(fn);
  }
  send(data) {
    this.sent.push(new Uint8Array(data));
  }
  close(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = { code, reason };
    this._emit("close", { code, reason });
  }
  _emit(type, ev) {
    for (const fn of this._ls.get(type) ?? []) fn(ev);
  }
  /** 客户端 → 服务端：只投递不等处理完（与真实事件模型一致：每条消息是独立任务） */
  fromClient(data) {
    const payload = data instanceof Uint8Array ? data : new Uint8Array(data);
    for (const fn of this._ls.get("message") ?? []) fn({ data: payload });
  }
  frames() {
    return this.sent.map((b) => ({ streamId: b[0], type: b[1], data: b.subarray(2) }));
  }
  typesOf(streamId) {
    return this.frames().filter((f) => f.streamId === streamId).map((f) => f.type);
  }
  payloadOf(streamId, type) {
    const f = this.frames().find((x) => x.streamId === streamId && x.type === type);
    return f ? new Uint8Array(f.data) : null;
  }
}

function installFakes() {
  globalThis.Response = FakeResponse;
  // worker.js 用 `new WebSocketPair()`，必须是可构造函数
  globalThis.WebSocketPair = function WebSocketPair() {
    const client = new FakeWS("client");
    const server = new FakeWS("server");
    globalThis.__LAST_SERVER__ = server;
    return [client, server];
  };
}
installFakes();

// ---------- 帧构造 ----------

export const T = { CONNECT: 0, CONNECTED: 1, DATA: 2, CLOSE: 3 };

export function frame(streamId, type, data) {
  const enc = new TextEncoder();
  const payload =
    data == null ? new Uint8Array(0) : typeof data === "string" ? enc.encode(data) : new Uint8Array(data);
  const out = new Uint8Array(2 + payload.length);
  out[0] = streamId;
  out[1] = type;
  out.set(payload, 2);
  return out;
}

export function connectFrame(streamId, host, port) {
  return frame(streamId, T.CONNECT, `${host}:${port}|`);
}

// ---------- 环境与会话 ----------

export function env(overrides = {}) {
  return {
    USER_ID: "testuser",
    FALLBACK_IPS: "",
    CONNECT_TIMEOUT: "1000",
    MAX_STREAMS_PER_CONNECTION: "16",
    ...overrides,
  };
}

/** 调用 worker.fetch；成功握手时返回 {res, client, server} */
export async function openSession(worker, { envVars = {}, path = "/testuser", query = "", upgrade = "websocket" } = {}) {
  const request = {
    url: `https://worker.test${path}${query}`,
    headers: { get: (k) => (k.toLowerCase() === "upgrade" ? upgrade : null) },
  };
  const res = await worker.fetch(request, env(envVars));
  return { res, client: res.webSocket, server: globalThis.__LAST_SERVER__ };
}

// ---------- 轮询等待 ----------

export async function waitFor(pred, { timeout = 2000, label = "condition" } = {}) {
  const start = Date.now();
  for (;;) {
    let v;
    try {
      v = pred();
    } catch {
      v = false;
    }
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`waitFor 超时: ${label}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

export function sockets() {
  return globalThis.__CF_STUB__?.sockets ?? [];
}

export function resetStub() {
  globalThis.__CF_STUB__?.reset();
}
