# GCM Worker 服务端部署

Cloudflare Worker 实现 GCM 协议服务端（WebSocket 二进制多路复用中继）。
仓库只携带 `worker.js` 一个文件——部署配置（域名、账号）留在你自己的环境里。

## 方式一：Dashboard 粘贴（最快）

1. Cloudflare Dashboard → Workers & Pages → Create Worker
2. 将 `worker.js` 全文粘贴到在线编辑器
3. 在 Worker 的 **Settings → Variables** 添加环境变量（见下表，至少 `USER_ID`）
4. 部署并记录 Worker URL（形如 `https://<name>.<account>.workers.dev/<USER_ID>`）

## 方式二：Wrangler

自建 `wrangler.toml`（`main = "worker.js"`），变量放 `[vars]`，然后：

```bash
npm install -g wrangler
wrangler deploy
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `USER_ID` | 用户鉴权 ID（URL 路径 `/USER_ID` 小写匹配；客户端 `--user-id` / `user_id` 需一致） |
| `FALLBACK_IPS` | 静态出口回退代理，逗号分隔（每项 host 或 host:port） |
| `ENABLE_FALLBACK` | 是否启用静态回退（`true`/`false`） |
| `DYNAMIC_NODES_URL` | 动态出口节点池 API（返回 JSON 列表） |
| `ENABLE_DYNAMIC_NODES` / `DYNAMIC_NODES_TIMEOUT` | 动态节点开关与超时（毫秒） |
| `CONNECT_TIMEOUT` | 出口连接超时（毫秒） |
| `MAX_STREAMS_PER_CONNECTION` | 单 WebSocket 连接最大流数 |
| `ENABLE_LOGGING` | 调试日志开关 |

## 客户端接入

- **gcm-cli**：`gcm --worker <worker域名> --user-id <USER_ID> --relay <prefIP:port> --proxy-ip <fip>`
- **x-client Android**：Profile 的 WorkerHost / UserID / PrefIp / FallbackIp 字段

出口优先级：直连原始 host > 客户端 `?fallbackip=` > 动态节点 API > 静态 `FALLBACK_IPS`。
