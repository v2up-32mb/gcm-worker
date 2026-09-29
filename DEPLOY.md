# GCM Worker 服务端部署

Cloudflare Worker 实现 GCM 协议服务端（WebSocket 二进制多路复用中继）。
仓库只携带 `worker.js` 一个文件——部署配置（域名、账号、`wrangler.toml`）留在你自己的环境里。

- 协议规范：[`gcm` 库仓](https://github.com/v2up-32mb/gcm) `protocol/message.go`（权威定义）
- 客户端：[`gcm-cli`](https://github.com/v2up-32mb/gcm-cli) / [`x-client`](https://github.com/v2up-32mb/x-client)（Android）

## 选择哪个产物

| 产物 | 用途 |
|---|---|
| `worker.js`（可读版，约 33 KiB） | 常规部署：下面的方式一/方式二都用它 |
| `worker.snippets.min.js`（压缩版，约 12 KiB / gzip 5 KiB） | Cloudflare **Snippets** 等对脚本体积有限制的场景 |

两者行为完全一致（CI 用同一套 123 条用例同时跑两个产物）。压缩版随 release 一起发布，
也可本地 `npm run build` 重建——**它是构建产物，不要手改**。

## 方式一：Dashboard 粘贴（最快）

1. Cloudflare Dashboard → Workers & Pages → Create Worker
2. 将 `worker.js` 全文粘贴到在线编辑器
3. 在 Worker 的 **Settings → Variables** 添加环境变量（见下表）。`USER_ID` **必填**：
   不配置 Worker 会拒绝所有连接（fail-closed），这是有意的安全默认。
4. 部署并记录 Worker URL（形如 `https://<name>.<account>.workers.dev/<USER_ID>`）

## 方式二：Wrangler

自建 `wrangler.toml`（复制模板 `cp wrangler.toml.example wrangler.toml`，改 `name` 与 `[vars]`）：

```bash
npx wrangler deploy        # 或全局安装：npm install -g wrangler && wrangler deploy
npx wrangler dev           # 本地调试：ws://localhost:8787/<USER_ID>
```

`wrangler.toml` 已被 `.gitignore` 排除（账号/域名/鉴权值不入库）。

## 环境变量

| 变量 | 说明 |
|---|---|
| `USER_ID` | **必填**。用户鉴权 ID（URL 路径 `/USER_ID`，**大小写不敏感**匹配；客户端 `--user-id` / `user_id` 需一致）。未配置或为空白时 Worker **拒绝一切接入**（返回 403 伪装页）并在日志记 `未配置 USER_ID`——不存在默认占位路径 |
| `FALLBACK_IPS` | 静态出口回退代理，逗号分隔（每项 host 或 host:port） |
| `SOCKS5_PROXY` | **proxy-all 模式的 socks5 出口**，逗号分隔，每项 `[socks5h?://][user:pass@]host[:port]`（缺端口默认 1080）。与 `?fallbackip=` 合并使用（客户端条目优先，超出 `MAX_FALLBACK_IPS` 部分截断）。仅 `?proxy-all=true` 时生效 |
| `ENABLE_FALLBACK` | 是否启用**全部回退出口**（`true`/`false`）：`false` 时只剩直连，客户端 `?fallbackip=`、动态节点、静态 `FALLBACK_IPS` 一并失效 |
| `DYNAMIC_NODES_URL` | 动态出口节点池 API（返回 JSON 列表）；拉取失败后进入 `DYNAMIC_NODES_TIMEOUT/2` 的负缓存窗口，窗口内复用 stale（无则为空）不再外呼。字段格式：`ip`/`host`/`address` 给纯主机或 IP（IPv6 可裸写或写 `[...]`），端口放独立 `port` 字段（`address` 自带 `host:port` 也支持） |
| `ENABLE_DYNAMIC_NODES` / `DYNAMIC_NODES_TIMEOUT` | 动态节点开关与超时（毫秒） |
| `CONNECT_TIMEOUT` | 出口连接超时（毫秒） |
| `MAX_STREAMS_PER_CONNECTION` | 单 WebSocket 连接最大流数 |
| `MAX_PENDING_BYTES` | 每条流的在途字节上限（字节，默认 `1048576`，范围 16KiB–8MiB）：预连接期未 flush 的早期数据 + 已连接期未确认写出的 DATA 合计，超限回 CLOSE |
| `MAX_FALLBACK_IPS` | `?fallbackip=` 条数上限（默认 `16`，范围 1–64），超出部分忽略 |
| `ENABLE_LOGGING` | 调试日志开关 |

## 客户端接入

- **gcm-cli**：`gcm --worker <worker域名> --user-id <USER_ID> --relay <prefIP:port> --proxy-ip <fip>`
- **x-client Android**：Profile 的 WorkerHost / UserID / PrefIp / FallbackIp 字段

出口优先级：直连原始 host > 客户端 `?fallbackip=` > 动态节点 API > 静态 `FALLBACK_IPS`
（后三级仅在 `ENABLE_FALLBACK=true` 时生效，动态节点另受 `ENABLE_DYNAMIC_NODES` 控制）。

## query 参数（非环境变量）

| 参数 | 说明 |
|---|---|
| `fallbackip` | 客户端侧出口偏好。**非 proxy-all**：每项 `host` 或 `host:port`（含 `[ipv6]` 方括号写法），条数受 `MAX_FALLBACK_IPS` 限制，L4 覆盖语义（配显式端口时目标端口被替换，节点靠报文自路由，不和握手的代理协议）。**proxy-all 模式**：每项必须是 **socks5 配置** `[socks5h?://][user:pass@]host[:port]`（含凭据时走 user/pass 认证），退化为代理流量出口 |
| `proxy-all` | 连接级开关。`1/true/yes/on`（大小写不敏感）= **只用 socks5 出口**：所有流跳过直连与 L4 回退链，直接向 socks5 代理发 CONNECT（携带原始目标），首代理失败自动试下一个；无 socks5 配置时零拨号直接回 CLOSE 并记 `?proxy-all=true 但无可用 socks5 出口`。缺省 `false`。v0.1.3 起语义变更：v0.1.2 的「跳过直连仍走 L4 链」已废弃 |

`fallbackip` 非 proxy-all 时的显式端口是 **L4 覆盖**语义（目标端口被替换、目标地址丢弃，节点靠报文自路由），
**不是 SOCKS5 / HTTP CONNECT 代理**——Worker 不做任何握手。

`proxy-all=true` 时出口换成 **socks5 代理**（`?fallbackip=` 与 `SOCKS5_PROXY` 都是 socks5 配置），
Worker 会向代理做 SOCKS5 握手并携带原始目标；一条都没配/都不可用时零拨号直接回 CLOSE。

## 已知限制

- **下行不计量**：`MAX_PENDING_BYTES` 只管**上行**（客户端 → 目标，含预连接缓存与在途未确认写出）。
  目标 → 客户端方向 Worker 侧不做字节/条数统计——Workers 的 `WebSocket.send()` 没有积压查询接口，
  只能依赖运行时的发送缓冲与 isolate 内存上限。弱网客户端大流量下载时可能触发 isolate 被回收。
