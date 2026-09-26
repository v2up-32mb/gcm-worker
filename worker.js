/**
 * Cloudflare Worker - GCM Proxy 服务端
 *
 * 对应客户端: gcm-cli（Go CLI，`gcm --worker <URL>`）与 x-client Android
 *   （AAR 内 gcm 库，Profile 的 WorkerHost 字段）
 * 功能: 通过 WebSocket 接收 GCM 二进制多路复用代理请求，转发到目标服务器
 *
 * 接入路径: wss://<worker域名>/<USER_ID>?fallbackip=<出口IP列表>
 *   - USER_ID 取 env.USER_ID（大小写不敏感匹配），不匹配的路径一律拒绝；
 *     未配置 USER_ID 时 fail-closed：任何路径都返回 403 伪装页，不存在默认占位路径
 *   - ?fallbackip= 可重复/逗号分隔，每项支持 host 或 host:port，作为客户端侧出口偏好
 *
 * 协议格式 (2字节头: [STREAM_ID:1][TYPE:1]，TYPE 语义见 gcm 库 protocol 包):
 * - 客户端 -> Worker: TYPE=0 CONNECT，DATA 为 ASCII "host:port|"
 * - 客户端 -> Worker: TYPE=2 DATA，[binary_data]
 * - 客户端 -> Worker: TYPE=3 CLOSE
 * - Worker -> 客户端: TYPE=1 CONNECTED（无 DATA）
 * - Worker -> 客户端: TYPE=2 DATA，[binary_data]
 * - Worker -> 客户端: TYPE=3 CLOSE
 *
 * 出口顺序: 直连原始 host > 客户端 ?fallbackip= > 动态节点 API（env.DYNAMIC_NODES_URL）> 静态 fallback（env.FALLBACK_IPS，
 *   每项支持 host 或 host:port；无硬编码默认值）
 *   注意：ENABLE_FALLBACK=false 会把第 2~4 级（?fallbackip=、动态节点、静态 FALLBACK_IPS）整体关闭，
 *   只剩直连；ENABLE_DYNAMIC_NODES 可单独关闭动态节点这一级。
 *
 * 仓库: https://github.com/v2up-32mb/gcm-worker
 *   协议规范（消息类型/头长度）以 gcm 库仓 protocol/message.go 为准，改动前先看 AGENTS.md
 *
 * 部署说明:
 * 1. 登录 Cloudflare Dashboard
 * 2. 进入 Workers & Pages
 * 3. 创建新 Worker
 * 4. 将此代码粘贴到编辑器
 * 5. 部署并记录 Worker URL
 * 6. 在 gcm-cli 的 --worker 参数（或 x-client Profile 的 WorkerHost）设置该 URL；
 *    环境变量（USER_ID/FALLBACK_IPS 等）见同目录 DEPLOY.md
 */

import { connect } from "cloudflare:sockets";

// ==================== 常量 ====================

// 早期数据缓存里每帧除 payload 外还有 Uint8Array/数组槽开销，按此计费，
// 否则空帧（payload 0 字节）能零成本绕过 MAX_PENDING_BYTES
const PENDING_FRAME_OVERHEAD = 32;

// ==================== 默认配置（兜底值；一切配置统一从环境变量读取） ====================
const DEFAULT_CONFIG = {
  enableFallback: true,
  connectTimeout: 1000,
  enableLogging: false,
  maxStreamsPerConnection: 16,
  maxPendingBytes: 1048576, // 预连接窗口内每条流最多缓存 1MiB 早期数据，超限即快速失败
  maxFallbackIPs: 16, // ?fallbackip= 条数上限，防止单条 CONNECT 拉出超长拨号链
  enableDynamicNodes: true,
  dynamicNodesUrl: "",
  dynamicNodesTimeout: 3000, // 拉取动态列表超时 3s，失败直接降级
};

const ENV_TRUE = new Set(["1", "true", "yes", "on"]);
const ENV_FALSE = new Set(["0", "false", "no", "off"]);

function parseEnvBool(v, fallback) {
  if (v === undefined || v === null || String(v).trim() === "") return fallback;
  const s = String(v).trim().toLowerCase();
  if (ENV_TRUE.has(s)) return true;
  if (ENV_FALSE.has(s)) return false;
  return fallback;
}

function parseEnvInt(v, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = parseInt(String(v ?? "").trim(), 10);
  if (!Number.isSafeInteger(n) || n < min || n > max) return fallback;
  return n;
}

// 一切配置从环境变量组装，不依赖 KV
function buildConfigFromEnv(env) {
  return {
    enableFallback: parseEnvBool(env.ENABLE_FALLBACK, DEFAULT_CONFIG.enableFallback),
    connectTimeout: parseEnvInt(env.CONNECT_TIMEOUT, DEFAULT_CONFIG.connectTimeout, { min: 100, max: 30000 }),
    enableLogging: parseEnvBool(env.ENABLE_LOGGING, DEFAULT_CONFIG.enableLogging),
    maxStreamsPerConnection: parseEnvInt(env.MAX_STREAMS_PER_CONNECTION, DEFAULT_CONFIG.maxStreamsPerConnection, { min: 1, max: 256 }),
    maxPendingBytes: parseEnvInt(env.MAX_PENDING_BYTES, DEFAULT_CONFIG.maxPendingBytes, { min: 16384, max: 8388608 }),
    maxFallbackIPs: parseEnvInt(env.MAX_FALLBACK_IPS, DEFAULT_CONFIG.maxFallbackIPs, { min: 1, max: 64 }),
    enableDynamicNodes: parseEnvBool(env.ENABLE_DYNAMIC_NODES, DEFAULT_CONFIG.enableDynamicNodes),
    dynamicNodesUrl: (env.DYNAMIC_NODES_URL || "").trim(),
    dynamicNodesTimeout: parseEnvInt(env.DYNAMIC_NODES_TIMEOUT, DEFAULT_CONFIG.dynamicNodesTimeout, { min: 500, max: 30000 }),
  };
}


// ==================== 消息类型常量 ====================
const MSG_TYPE = {
  CONNECT: 0,
  CONNECTED: 1,
  DATA: 2,
  CLOSE: 3,
};

// ==================== 伪装页面 HTML ====================
const FAKE_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="3;url=https://www.whitehouse.gov/">
    <title>Access Denied</title>
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f0f0f0; }
        .box { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; max-width: 400px; width: 90%; }
        h1 { color: #d32f2f; margin: 0 0 16px; font-size: 24px; }
        p { color: #666; margin: 0; font-size: 14px; }
        .spinner { width: 20px; height: 20px; border: 2px solid #f3f3f3; border-top: 2px solid #666; border-radius: 50%; animation: spin 1s linear infinite; margin: 20px auto 0; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="box">
        <h1>You are not allowed to access this site.</h1>
        <p>System has detected unauthorized access attempt.</p>
        <p style="margin-top: 10px; font-size: 12px; color: #999;">Redirecting to security center...</p>
        <div class="spinner"></div>
    </div>
</body>
</html>`;

// ==================== 工具函数 ====================
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// 客户端可控内容（CONNECT 负载、?fallbackip 条目）会进日志行，
// 去掉控制字符并截断，避免伪造日志行/污染终端
function cleanLog(s) {
  return String(s).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
}

function log(scope, message, enableLogging = false) {
  if (enableLogging) {
    console.log(`[${scope}] ${cleanLog(message)}`);
  }
}

function logError(scope, message) {
  console.error(`[${scope}] ${cleanLog(message)}`);
}

// 解析地址 (Host:Port)
// 拼装 {host, port}：host 非空、port 为 1..65535 的十进制整数，否则返回 null
function withPort(host, portText) {
  const h = String(host || "").trim();
  if (!h || !/^\d+$/.test(portText)) return null;
  const port = parseInt(portText, 10);
  return port >= 1 && port <= 65535 ? { host: h, port } : null;
}

// 解析 CONNECT 负载里的目标地址：host:port 或 [ipv6]:port
// 客户端（gcm StreamDialer）先 net.SplitHostPort 再拼 "host:port|"，故收到的是无方括号形态，
// 裸 IPv6 靠 lastIndexOf 取到端口
// 非法地址（空 host / 端口非数字或越界）返回 null，由调用方关流
function parseAddress(addr) {
  const s = String(addr || "").trim();
  if (!s) return null;
  if (s[0] === "[") {
    const end = s.indexOf("]");
    if (end === -1) return null;
    const rest = s.substring(end + 1);
    if (rest && rest[0] !== ":") return null;
    return withPort(s.substring(1, end), rest ? rest.substring(1) : "");
  }
  const sep = s.lastIndexOf(":");
  return sep === -1 ? null : withPort(s.substring(0, sep), s.substring(sep + 1));
}

// 解析 fallback 条目，支持 `host`、`host:port`、`[ipv6]`、`[ipv6]:port`、裸 IPv6（如 `2606:4700::1`）
// 不带端口时继承目标端口（保持旧行为）
function parseFallbackEntry(entry, defaultPort) {
  const s = String(entry || "").trim();
  if (!s) return null;
  // [ipv6] 或 [ipv6]:port
  if (s[0] === "[") {
    const end = s.indexOf("]");
    if (end === -1) return null;
    const host = s.substring(1, end);
    if (!host) return null;
    const rest = s.substring(end + 1);
    if (!rest) return { host, port: defaultPort };
    if (rest[0] !== ":") return null;
    return withPort(host, rest.substring(1));
  }
  // 无冒号：纯 host，继承端口
  const sep = s.lastIndexOf(":");
  if (sep === -1) return { host: s, port: defaultPort };
  // 端口前的主机名不含冒号时，尾段才是端口（host:port）；否则整串是裸 IPv6，同样继承端口
  if (s.substring(0, sep).includes(":")) return { host: s, port: defaultPort };
  return withPort(s.substring(0, sep), s.substring(sep + 1));
}

// 逗号分隔的地址列表（?fallbackip= 与 FALLBACK_IPS 通用）
function splitList(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// 大小写不敏感去重
function dedupList(arr) {
  const out = [];
  const seen = new Set();
  for (const h of arr) {
    const key = h.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(h);
    }
  }
  return out;
}

// ==================== 动态兜底节点 ====================
// Workers isolate 生命周期短，成功结果不做 TTL 缓存：每次用到都现拉 API。
// 仅保留单飞（并发流共用一次请求）+ 失败时复用上次结果的 stale 降级。
// 失败加一个短负缓存窗口（复用 dynamicNodesTimeout）：否则 API 挂掉时每条流都要
// 空等满 DYNAMIC_NODES_TIMEOUT 才拨静态回退，还会对故障 API 反复发 subrequest。
let dynamicNodesCache = { entries: [], inflight: null, failedAt: 0 };

function normalizeNodeEntry(host, port) {
  let h = String(host ?? "").trim();
  if (!h) return null;
  // API 可能返回裸 IPv6，统一加方括号，后续走 parseFallbackEntry 解析。
  // 但 "host:port" 形态（address 字段常见）不能加括号，否则会被当成一个畸形主机名。
  if (h.includes(":") && h[0] !== "[") {
    const looksLikeHostPort = h.indexOf(":") === h.lastIndexOf(":") && /:\d+$/.test(h);
    if (!looksLikeHostPort) h = `[${h}]`;
  }
  if (port !== undefined && port !== null && String(port).trim() !== "") {
    const p = parseInt(port, 10);
    if (!Number.isSafeInteger(p) || p <= 0 || p > 65535) return null;
    return `${h}:${p}`;
  }
  return h;
}

async function fetchDynamicNodes(config) {
  // 地址统一从环境变量读取，无硬编码默认值；未配置则直接降级为空
  const url = (config.dynamicNodesUrl || "").trim();
  if (!url) return [];
  const timeoutMs = config.dynamicNodesTimeout || 3000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const arr = Array.isArray(data) ? data : data.nodes || data.data || [];
    const out = [];
    const seen = new Set();
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const entry = normalizeNodeEntry(
        item.ip || item.host || item.address,
        item.port,
      );
      if (!entry) continue;
      const key = entry.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
      if (out.length >= 20) break;
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function getDynamicFallbacks(config) {
  if (config.enableDynamicNodes === false) return [];
  if (!(config.dynamicNodesUrl || "").trim()) return [];
  // 失败负缓存窗口内直接复用 stale（无 stale 即空），不再等一次满超时
  const cooldown = (config.dynamicNodesTimeout || 3000) / 2;
  if (dynamicNodesCache.failedAt && Date.now() - dynamicNodesCache.failedAt < cooldown) {
    return dynamicNodesCache.entries;
  }
  // 无 TTL：每次现拉，仅单飞合并并发请求
  if (dynamicNodesCache.inflight) {
    try {
      return await dynamicNodesCache.inflight;
    } catch {
      return dynamicNodesCache.entries;
    }
  }
  const p = fetchDynamicNodes(config)
    .then((entries) => {
      dynamicNodesCache.entries = entries;
      dynamicNodesCache.inflight = null;
      dynamicNodesCache.failedAt = 0;
      return entries;
    })
    .catch((err) => {
      logError("DynamicNodes", `拉取失败: ${err.message}`);
      dynamicNodesCache.inflight = null;
      dynamicNodesCache.failedAt = Date.now();
      return dynamicNodesCache.entries; // 有 stale 用 stale，全新失败则为 []
    });
  dynamicNodesCache.inflight = p;
  return p;
}

// 建立 TCP 连接并等待就绪（上限 timeoutMs）；onSocket 在 connect() 后立即回调，
// 让调用方登记在途 socket——流被客户端放弃时可以立刻取消，不必等满 CONNECT_TIMEOUT
// 竞速失败（超时/连接被拒）一律 close：socket 在 connect() 时就已存在，
// 迟到的成功连接否则会一直挂到 isolate 结束
async function dialWithTimeout(host, port, timeoutMs, onSocket) {
  const socket = connect({ hostname: host, port });
  onSocket?.(socket);
  let won = false;
  let timer = null;
  try {
    return await Promise.race([
      socket.opened.then((v) => {
        won = true;
        return v;
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Connection timeout")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (!won) {
      try {
        socket.close();
      } catch {}
    }
  }
}

// 安全关闭 WebSocket
// readyState: 0 CONNECTING / 1 OPEN / 2 CLOSING
function safeCloseWebSocket(ws) {
  try {
    if (ws.readyState === 1 || ws.readyState === 2) {
      ws.close(1000, "Server closed");
    }
  } catch {}
}

// ==================== 多路复用流管理器 ====================
/**
 * 流管理器 - 管理多个多路复用流
 * 每个流对应一个到目标服务器的 TCP 连接
 */
class StreamManager {
  constructor(webSocket, config) {
    this.webSocket = webSocket;
    this.config = config;
    // streams: Map<streamId, { remoteSocket, remoteWriter, remoteReader, isClosed }>
    this.streams = new Map();
    this.streamCount = 0;
  }

  log(message) {
    log("Mux", message, this.config.enableLogging);
  }

  /**
   * 创建新流并连接目标服务器
   */
  async createStream(streamId, targetAddr) {
    // 检查流是否已存在
    if (this.streams.has(streamId)) {
      this.log(`流 ${streamId} 已存在，关闭旧流`);
      this.closeStream(streamId);
    }

    // 检查最大并发流数
    if (this.streamCount >= this.config.maxStreamsPerConnection) {
      // 无独立错误帧：CLOSE 即表示该流已终止
      this.sendFrame(streamId, MSG_TYPE.CLOSE);
      return false;
    }

    // 预注册 stream（乐观模式）：TCP 尚未连上时缓存客户端早期数据
    // 客户端在发 CONNECT 后会乐观发送 SOCKS5 成功并开始转发数据
    // 这些数据可能在 CONNECTED 之前到达，需要缓存等 TCP 连上后 flush
    // 注意：stream 对象本身是"这一代流"的身份凭据——重复 CONNECT 会换新对象，
    // 在途的 tryDial/pump 回来时必须按对象身份判定自己是否已被换掉（见 tryDial/pump）
    const stream = {
      id: streamId,
      remoteSocket: null,
      dialing: null, // 在途（尚未就绪）的 socket
      remoteWriter: null,
      remoteReader: null,
      isClosed: false,
      closeNotified: false, // 是否已回过 CLOSE（每条流至多一帧）
      tcpConnected: false,
      pendingBuffer: [],
      pendingBytes: 0,
    };
    this.streams.set(streamId, stream);
    this.streamCount++;

    const target = parseAddress(targetAddr);
    if (!target) {
      // 目标地址非法：没有可试的出口，回 CLOSE 让客户端立即失败（不再无谓遍历回退列表）
      this.log(`[${streamId}] 目标地址不可解析: ${targetAddr}`);
      this.sendCloseFor(stream);
      this.closeStreamObject(stream);
      return false;
    }
    const { host, port } = target;
    // 出口顺序：直连 > 客户端传入 fallback > 动态节点 > 静态 fallback
    // 1. 直连优先
    {
      const r = await this.tryDial(stream, host, port, "直连");
      if (r === "connected") return true;
      if (r === "aborted") return false;
    }

    if (!this.config.enableFallback) {
      // 明确提示：ENABLE_FALLBACK=false 会连带关掉客户端 ?fallbackip= 与动态节点，
      // 不只是静态 FALLBACK_IPS（避免运维以为客户端传的出口偏好仍然生效）
      this.log("客户端 ?fallbackip= 与动态/静态回退已被 ENABLE_FALLBACK=false 全部关闭");
    }

    if (this.config.enableFallback) {
      // 去重集合：前面已试过的，后面不再重复试（直连已试过，播种进去）
      const seenHosts = new Set([`${host.toLowerCase()}:${port}`]);

      // 出口链 2~4 级，顺序即对外契约（AGENTS 约束 6）：
      //   客户端 ?fallbackip= > 动态节点 API > 静态 FALLBACK_IPS
      // 三级只有数据源与日志前缀不同，合并成一次遍历；动态节点要现拉，放在最前面惰性求值。
      for (const [label, list] of [
        ["query-fallback", this.config.cfQueryFallbackIPs || []],
        ["dynamic", await getDynamicFallbacks(this.config)],
        ["fallback", this.config.cfFallbackIPs || []],
      ]) {
        // 动态节点拉取可能耗时，await 之后要复查流是否还在
        if (stream.isClosed) return false;
        let n = 0;
        for (const entry of list) {
          const parsed = parseFallbackEntry(entry, port);
          if (!parsed) {
            this.log(`[${streamId}] 跳过非法${label}: ${entry}`);
            continue;
          }
          const key = `${parsed.host.toLowerCase()}:${parsed.port}`;
          if (seenHosts.has(key)) continue;
          seenHosts.add(key);
          n++;
          const r = await this.tryDial(stream, parsed.host, parsed.port, `${label}[${n}/${list.length}]`);
          if (r === "connected") return true;
          if (r === "aborted") return false;
        }
        this.log(`[${streamId}] ${label}: 尝试 ${n}/${list.length} 个出口`);
      }
    }

    // 所有尝试都失败：回 CLOSE 让客户端立即失败（否则客户端只能等自己的超时），再清理预注册的流
    this.sendCloseFor(stream);
    this.closeStreamObject(stream);
    return false;
  }

  /**
   * 单次拨号并绑定到流
   * @param {object} stream 本代流对象（身份凭据：await 回来后据此判断自己是否已被换掉）
   * @returns {Promise<"connected" | "aborted" | "failed">} connected=成功停手，aborted=流已没（停手不再试），failed=可试下一个
   */
  async tryDial(stream, attemptHost, attemptPort, attemptDesc) {
    const streamId = stream.id;
    if (stream.isClosed) return "aborted";
    try {
      this.log(`[${streamId}] 尝试${attemptDesc}: ${attemptHost}:${attemptPort}`);

      // 等待连接建立或超时；超时/失败一律回收 socket（否则迟到的连接会挂到 isolate 结束）
      const remoteSocket = await dialWithTimeout(
        attemptHost,
        attemptPort,
        this.config.connectTimeout,
        (sock) => {
          stream.dialing = sock; // 登记在途 socket，供 closeStreamObject 立即取消
        },
      );
      stream.dialing = null;

      const remoteWriter = remoteSocket.writable.getWriter();
      const remoteReader = remoteSocket.readable.getReader();

      // 身份校验：等待期间流可能已被关闭、或被同 streamId 的新 CONNECT 换掉。
      // 按 streamId 回表会误绑到新一代流上（双 CONNECTED + socket 泄漏 + 跨流串数据），
      // 因此这里比对象身份，不一致就回收自己的 socket 后退出。
      if (stream.isClosed || this.streams.get(streamId) !== stream) {
        try { remoteWriter.releaseLock(); } catch {}
        try { remoteSocket.close(); } catch {}
        return "aborted";
      }
      stream.remoteSocket = remoteSocket;
      stream.remoteWriter = remoteWriter;
      stream.remoteReader = remoteReader;

      this.log(`[${streamId}] ${attemptDesc}成功`);

      // Flush 缓存的早期数据到远程 socket
      if (stream.pendingBuffer.length > 0) {
        this.log(`[${streamId}] flush ${stream.pendingBuffer.length} 条缓存数据`);
        for (const pending of stream.pendingBuffer) {
          try {
            await remoteWriter.write(pending.chunk);
            // 写出即释放额度：早期数据的计量只是"暂存"，写完必须回退，
            // 否则这条流的在途预算被历史早期数据永久占用，后续正常 DATA 会被误杀
            stream.pendingBytes -= pending.cost;
          } catch (e) {
            this.log(`[${streamId}] flush 写入失败: ${e.message}`);
            // 尚未 sendConnected，也没有 pump 兜底发 CLOSE，必须自己回一帧让客户端快速失败
            this.sendCloseFor(stream);
            this.closeStreamObject(stream);
            return "aborted";
          }
        }
        stream.pendingBuffer = [];
      }

      // flush 循环里有 await，流可能在此期间被客户端关闭、或被同 streamId 的新 CONNECT 接管；
      // 置位 tcpConnected / 发 CONNECTED / 起 pump 之前必须再确认一次身份，
      // 否则旧代仍会为已被换掉的 id 发第二帧 CONNECTED（双 CONNECTED 窗口）
      if (stream.isClosed || this.streams.get(streamId) !== stream) {
        try { remoteWriter.releaseLock(); } catch {}
        try { remoteSocket.close(); } catch {}
        return "aborted";
      }

      // 必须等 flush 结束再置位：flush 期间到达的客户端 DATA 要继续进 pendingBuffer，
      // 否则会插到未写完的缓存条目中间，破坏发往目标的字节序（TLS/HTTP 会被判协议错误）
      stream.tcpConnected = true;

      this.sendFrame(streamId, MSG_TYPE.CONNECTED);

      // 启动数据转发
      this.pumpRemoteToWebSocket(stream, remoteReader);

      return "connected";
    } catch (err) {
      this.log(`[${streamId}] ${attemptDesc}失败: ${err.message}`);
      // 流已死（客户端 CLOSE / WS 关闭 / 被同 id 新流换掉）就停手，别再遍历剩余出口
      return stream.isClosed || this.streams.get(streamId) !== stream ? "aborted" : "failed";
    }
  }

  /**
   * 获取流
   */
  getStream(streamId) {
    return this.streams.get(streamId);
  }

  /**
   * 写入数据到流
   */
  async writeStream(streamId, data) {
    const stream = this.getStream(streamId);
    if (!stream || stream.isClosed) {
      return false;
    }


    const chunk = data instanceof Uint8Array ? data : encoder.encode(data);
    // 未连通：缓存待 flush；已连通：在途未确认写出。两者都计入 pendingBytes 并受
    // maxPendingBytes 约束——message 监听器不会被运行时 await，目标慢读/黑洞时
    // 写出队列只增不减，没有这道闸就会线性撑爆 isolate 内存
    const cost = chunk.length + PENDING_FRAME_OVERHEAD;
    stream.pendingBytes += cost;
    if (stream.pendingBytes > this.config.maxPendingBytes) {
      this.log(`[${streamId}] 缓冲/在途字节超过上限 ${this.config.maxPendingBytes}B，关流`);
      this.sendCloseFor(stream);
      this.closeStreamObject(stream);
      return false;
    }

    if (!stream.tcpConnected) {
      stream.pendingBuffer.push({ chunk, cost });
      return true;
    }

    try {
      await stream.remoteWriter.write(chunk);
      return true;
    } catch (e) {
      this.log(`[${streamId}] 写入失败: ${e.message}`);
      this.sendCloseFor(stream);
      this.closeStreamObject(stream);
      return false;
    } finally {
      stream.pendingBytes -= cost;
    }
  }

  /**
   * 按 id 关闭流（客户端 CLOSE / 重复 CONNECT 时用）
   */
  closeStream(streamId) {
    this.closeStreamObject(this.getStream(streamId));
  }

  /**
   * 按对象关闭流：只回收自己的资源，只有仍是该 id 的现任流才从表里摘除
   * （避免旧代收尾把同 id 的新流误删、误占 streamCount 槽位）
   */
  closeStreamObject(stream) {
    if (!stream || stream.isClosed) return;

    stream.isClosed = true;

    // 清理缓存
    stream.pendingBuffer = [];
    stream.pendingBytes = 0;

    try {
      stream.remoteWriter?.releaseLock();
    } catch {}
    try {
      stream.remoteReader?.releaseLock();
    } catch {}
    try {
      stream.remoteSocket?.close();
    } catch {}
    try {
      stream.dialing?.close(); // 取消在途拨号，不让它占着连接额度直到超时
    } catch {}

    if (this.streams.get(stream.id) === stream) {
      this.streams.delete(stream.id);
      this.streamCount--;
      this.log(`[${stream.id}] 流已关闭，剩余流: ${this.streamCount}`);
    }
  }

  /**
   * 发送一帧：[STREAM_ID:1][TYPE:1][可选 DATA]
   * payload 为空时发 2 字节裸头（CONNECTED/CLOSE 按协议不带负载）
   */
  sendFrame(streamId, type, payload) {
    try {
      if (!payload || payload.length === 0) {
        this.webSocket.send(new Uint8Array([streamId, type]));
        return;
      }
      const frame = new Uint8Array(2 + payload.length);
      frame[0] = streamId;
      frame[1] = type;
      frame.set(payload, 2);
      this.webSocket.send(frame);
    } catch {}
  }

  /**
   * 通知客户端该流已终止：每条流至多回一帧 CLOSE。
   * 若同 streamId 已被新一代流接管则不发（否则会误杀客户端刚建好的新流）；
   * 若本流已被 closeStreamObject 摘除但客户端还没收到过终止帧（如写失败路径），
   * 仍补发——否则客户端只能等自己的超时。
   */
  sendCloseFor(stream) {
    if (stream.closeNotified) return;
    const current = this.streams.get(stream.id);
    if (current && current !== stream) return;
    stream.closeNotified = true;
    this.sendFrame(stream.id, MSG_TYPE.CLOSE);
  }

  /**
   * 将远程 Socket 数据转发给 WebSocket
   * 收尾（CLOSE/删表）前先校验对象身份：旧代的 pump 不能把新一代的同 id 流判死
   */
  async pumpRemoteToWebSocket(stream, remoteReader) {
    const streamId = stream.id;
    try {
      while (true) {
        const { done, value } = await remoteReader.read();

        if (done) break;
        // 流已被换掉/关闭：停止转发并回收，别把旧源的字节记到新流名下
        if (stream.isClosed || this.streams.get(streamId) !== stream) break;
        if (value?.byteLength > 0) {
          this.sendFrame(streamId, MSG_TYPE.DATA, value);
        }
      }
    } catch (e) {
      this.log(`[${streamId}] 转发异常: ${e.message}`);
    }

    // 转发结束，关闭流（sendCloseFor 内部会判断同 id 是否已被新一代接管）
    this.sendCloseFor(stream);
    this.closeStreamObject(stream);
  }

  /**
   * 关闭所有流
   */
  closeAll() {
    for (const [streamId] of this.streams) {
      this.closeStream(streamId);
    }
  }

}

// ==================== 主入口 ====================
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      // 0. 获取认证 ID：缺省即 fail-closed。
      // 此前退到硬编码公开路径 /uuid-placeholder，等于未鉴权的开放代理（占位串随源码公开）。
      const rawUserID = String(env.USER_ID ?? "").trim();
      if (!rawUserID) {
        logError("Server", "未配置 USER_ID，拒绝一切接入（fail-closed）");
        return new Response(FAKE_PAGE_HTML, {
          status: 403,
          headers: { "Content-Type": "text/html;charset=UTF-8" },
        });
      }
      const userID = rawUserID.toLowerCase();
      const validPath = `/${userID}`;
      // 请求侧也按小写比较：客户端把 --user-id 原样放进路径，
      // 单侧小写会让含大写字母的 USER_ID 即便两端配置一致也永远 403
      const isValidPath = (p) => p.toLowerCase() === validPath;

      // 1. 路由判断: 仅 /USER_ID 处理 WebSocket
      if (isValidPath(url.pathname)) {
        const upgradeHeader = request.headers.get("Upgrade");
        if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
          return new Response("Expected WebSocket", { status: 426 });
        }

        // 2. 加载配置（仅环境变量，无 KV 依赖）
        const baseConfig = buildConfigFromEnv(env);

        // 3. 解析 Fallback IPs（地址统一从环境变量读取，无硬编码）：
        // ?fallbackip=（客户端传入，支持逗号分隔与重复参数，每项支持 host 或 host:port）
        // env.FALLBACK_IPS（服务端静态，唯一来源）
        // 尝试顺序由 StreamManager.createStream() 按 直连 > 客户端 > 动态 > 静态 执行
        const queryFallbackIPs = dedupList(
          url.searchParams.getAll("fallbackip").flatMap(splitList),
        );
        if (queryFallbackIPs.length > baseConfig.maxFallbackIPs) {
          log(
            "WS",
            `?fallbackip= 条目 ${queryFallbackIPs.length} 超过上限 ${baseConfig.maxFallbackIPs}，已截断`,
            baseConfig.enableLogging,
          );
          queryFallbackIPs.length = baseConfig.maxFallbackIPs;
        }
        const envFallbackIPs = splitList(env.FALLBACK_IPS);
        // 静态 fallback 只从环境变量读取，不再合并硬编码默认值
        const staticFallbackIPs = dedupList([...envFallbackIPs]);

        const config = {
          ...baseConfig,
          cfQueryFallbackIPs: queryFallbackIPs,
          cfFallbackIPs: staticFallbackIPs,
        };

        // 4. 建立连接
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();

        log("WS", "连接已建立", config.enableLogging);

        // 处理会话
        handleSession(server, config).catch(() => safeCloseWebSocket(server));

        // 返回 101 Switching Protocols
        return new Response(null, {
          status: 101,
          webSocket: client,
        });
      }

      // 其他所有路径处理 (包括原本的 /ws 如果 USER_ID 不匹配)
      return new Response(FAKE_PAGE_HTML, {
        status: 403,
        headers: { "Content-Type": "text/html;charset=UTF-8" },
      });
    } catch (err) {
      logError("Server", err.toString());
      return new Response(err.toString(), { status: 500 });
    }
  },
};

// ==================== 会话处理 ====================
async function handleSession(webSocket, config) {
  let isClosed = false;
  // 立即初始化流管理器 - 只使用新协议
  const streamManager = new StreamManager(webSocket, config);

  // 清理资源
  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;
    streamManager.closeAll();
    safeCloseWebSocket(webSocket);
  };

  // 协议头长度常量
  const HEADER_LEN = 2; // [STREAM_ID:1][TYPE:1]

  // 监听客户端消息
  webSocket.addEventListener("message", async (event) => {
    if (isClosed) return;

    try {
      const data = event.data;

      // 只接受二进制消息：文本帧的 event.data 是 string，交给下游会抛 TypeError
      // 并把整条会话（含其它流）一起拆掉
      if (typeof data === "string") {
        logError("Mux", "忽略非二进制消息（文本帧）");
        return;
      }
      const uint8Array =
        data instanceof ArrayBuffer ? new Uint8Array(data) : data;

      if (uint8Array.length < HEADER_LEN) {
        logError("Mux", `消息太短: ${uint8Array.length} 字节`);
        return;
      }

      // 解析头部 (2字节精简协议: [STREAM_ID:1][TYPE:1])
      const streamId = uint8Array[0]; // 1 byte: Stream ID
      const msgType = uint8Array[1]; // 1 byte: Type

      // 处理不同类型的消息
      if (msgType === MSG_TYPE.CONNECT) {
        // CONNECT 消息: [STREAM_ID:1][TYPE:1]{host:port}|
        // 提取目标地址
        const payload = decoder.decode(uint8Array.slice(HEADER_LEN));
        // 负载是 "host:port|"；缺尾杠时按整串解析（容忍非本仓客户端的轻微差异）
        const bar = payload.lastIndexOf("|");
        const targetAddr = bar >= 0 ? payload.substring(0, bar) : payload;
        streamManager.log(`[${streamId.toString(16)}] 连接请求: ${targetAddr}`);
        await streamManager.createStream(streamId, targetAddr);
      } else if (msgType === MSG_TYPE.DATA) {
        // DATA 消息: [STREAM_ID:1][TYPE:1][binary_data]
        const binaryData = uint8Array.slice(HEADER_LEN);
        await streamManager.writeStream(streamId, binaryData);
      } else if (msgType === MSG_TYPE.CLOSE) {
        // CLOSE 消息: [STREAM_ID:1][TYPE:1]
        streamManager.log(`[${streamId.toString(16)}] 关闭流`);
        // 客户端主动关闭：标记已通知，抑制 pump 收尾的回帧（否则杂散 CLOSE 可能落在
        // 客户端「已注册 handler、还没收到 CONNECTED」的同 id 复用窗口里，把新流打断）
        const closing = streamManager.getStream(streamId);
        if (closing) closing.closeNotified = true;
        streamManager.closeStream(streamId);
      } else {
        logError("Mux", `未知消息类型: ${msgType}`);
      }
    } catch (err) {
      logError("Handler", err.message);
      cleanup();
    }
  });

  webSocket.addEventListener("close", () => {
    log("WS", "连接已关闭", config.enableLogging);
    cleanup();
  });

  webSocket.addEventListener("error", (err) => {
    logError("WS", err?.message || "Unknown error");
    cleanup();
  });
}