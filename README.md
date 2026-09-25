# gcm-worker

GCM 二进制多路复用协议的 **Cloudflare Worker 服务端**（对应
[`gcm`](https://github.com/v2up-32mb/gcm) Go 核心库的服务端对端）。

单条 WebSocket 承载多条多路复用流，按 2 字节头协议把每条流转发到目标 TCP 服务器。
客户端：[`gcm-cli`](https://github.com/v2up-32mb/gcm-cli)（CLI）、
[`x-client`](https://github.com/v2up-32mb/x-client)（Android，Profile 的 WorkerHost 字段）。

> 本仓自 gcm 库仓 `worker/` 目录独立出来（内容与 gcm `v0.1.1` 一致），协议与库仓共享同一份规范。

## 协议

2 字节头二进制多路复用（`[STREAM_ID:1][TYPE:1][可选 DATA]`）：

```
TYPE = 0 CONNECT    DATA = ASCII "host:port|"
TYPE = 1 CONNECTED  无 DATA
TYPE = 2 DATA       [binary_data]
TYPE = 3 CLOSE      无 DATA
```

客户端接入：`wss://<worker域名>/<user_id>?fallbackip=<出口IP列表>`
（`USER_ID` 取环境变量，路径小写匹配；`?fallbackip=` 可重复/逗号分隔，每项 `host` 或 `host:port`）。

出口顺序：**直连原始 host > 客户端 `?fallbackip=` > 动态节点 API（`DYNAMIC_NODES_URL`）>
静态 `FALLBACK_IPS`**。

常量的权威定义在 gcm 库仓 `protocol/message.go`；本仓用
`npm run check:protocol` 与之比对，防止两侧漂移（详见 `AGENTS.md`）。

## 快速开始

```bash
cp wrangler.toml.example wrangler.toml   # 填 name / [vars] USER_ID
npm install -g wrangler
wrangler dev      # 本地调试（wss://localhost:8787/<USER_ID>）
wrangler deploy
```

Dashboard 粘贴部署（最快，无需本地环境）见 [`DEPLOY.md`](DEPLOY.md)，含完整环境变量表。

## 目录

| 文件 | 职责 |
|---|---|
| `worker.js` | Worker 主脚本，**单文件自包含**（无构建步骤、无运行时依赖），头部注释即接入与协议说明 |
| `DEPLOY.md` | 部署方式（Dashboard 粘贴 / Wrangler）与环境变量表 |
| `scripts/check-protocol.mjs` | 与 gcm `protocol/message.go` 比对消息类型/头长度，防协议漂移 |
| `wrangler.toml.example` | Wrangler 配置模板（真实 `wrangler.toml` 不入库） |

## 测试

```bash
npm run check          # node --check（语法）+ 协议一致性检查
npm run check:syntax   # 仅语法
npm run check:protocol # 仅协议一致性（未检出 gcm 库仓时降级为自检并提示）
```

端到端：本地 `wrangler dev` 后用 gcm-cli 指向 `ws://localhost:8787/<USER_ID>` 跑一次代理。

## 版本与发版

- 逐版本变更与升级指引见 [`CHANGELOG.md`](CHANGELOG.md)；协作约束（含**发版铁律：不得未经人工批准自行打 tag 并推送**）见 [`AGENTS.md`](AGENTS.md)。
- **协议变更即破坏性变更**：改消息类型/头格式/出口顺序前，先确认 gcm 库仓与客户端同步方案。
