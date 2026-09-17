# GCM Worker 服务端部署

Cloudflare Worker 实现 GCM 协议服务端（WebSocket 二进制多路复用中继）。

## 部署

```bash
npm install -g wrangler
wrangler deploy   # 读取 wrangler.toml（需先填 account_id 与域名 routes）
```

## 配置（wrangler.toml [vars]）

| 变量 | 说明 |
|---|---|
| `USER_ID` | 用户鉴权 ID（客户端 `--user-id` 需匹配） |
| `FALLBACK_IPS` | 出口回退代理（逗号分隔；对应客户端 `--proxy-ip`/`fip`） |
| `ENABLE_DYNAMIC_NODES` / `DYNAMIC_NODES_URL` | 动态出口节点池 |
| `CONNECT_TIMEOUT` | 出口连接超时（毫秒） |
| `MAX_STREAMS_PER_CONNECTION` | 单 WebSocket 连接最大流数 |

客户端侧对应入口示例：`gcm --worker gcm.ics.de5.net --user-id v2up --relay <prefIP:port> --proxy-ip <fip>`
