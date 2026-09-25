# GCM Worker 服务端部署

Cloudflare Worker 实现 GCM 协议服务端（WebSocket 二进制多路复用中继）。
仓库只携带 `worker.js` 一个文件——部署配置（域名、账号、`wrangler.toml`）留在你自己的环境里。

- 协议规范：[`gcm` 库仓](https://github.com/v2up-32mb/gcm) `protocol/message.go`（权威定义）
- 客户端：[`gcm-cli`](https://github.com/v2up-32mb/gcm-cli) / [`x-client`](https://github.com/v2up-32mb/x-client)（Android）

## 方式一：Dashboard 粘贴（最快）

1. Cloudflare Dashboard → Workers & Pages → Create Worker
2. 将 `worker.js` 全文粘贴到在线编辑器
3. 在 Worker 的 **Settings → Variables** 添加环境变量（见下表，至少 `USER_ID`）
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
| `USER_ID` | 用户鉴权 ID（URL 路径 `/USER_ID`，**大小写不敏感**匹配；客户端 `--user-id` / `user_id` 需一致） |
| `FALLBACK_IPS` | 静态出口回退代理，逗号分隔（每项 host 或 host:port） |
| `ENABLE_FALLBACK` | 是否启用静态回退（`true`/`false`） |
| `DYNAMIC_NODES_URL` | 动态出口节点池 API（返回 JSON 列表）；拉取失败后进入 `DYNAMIC_NODES_TIMEOUT/2` 的负缓存窗口，窗口内复用 stale（无则为空）不再外呼 |
| `ENABLE_DYNAMIC_NODES` / `DYNAMIC_NODES_TIMEOUT` | 动态节点开关与超时（毫秒） |
| `CONNECT_TIMEOUT` | 出口连接超时（毫秒） |
| `MAX_STREAMS_PER_CONNECTION` | 单 WebSocket 连接最大流数 |
| `MAX_PENDING_BYTES` | 每条流的在途字节上限（字节，默认 `1048576`，范围 16KiB–8MiB）：预连接期未 flush 的早期数据 + 已连接期未确认写出的 DATA 合计，超限回 CLOSE |
| `MAX_FALLBACK_IPS` | `?fallbackip=` 条数上限（默认 `16`，范围 1–64），超出部分忽略 |
| `ENABLE_LOGGING` | 调试日志开关 |

## 客户端接入

- **gcm-cli**：`gcm --worker <worker域名> --user-id <USER_ID> --relay <prefIP:port> --proxy-ip <fip>`
- **x-client Android**：Profile 的 WorkerHost / UserID / PrefIp / FallbackIp 字段

出口优先级：直连原始 host > 客户端 `?fallbackip=` > 动态节点 API > 静态 `FALLBACK_IPS`。
