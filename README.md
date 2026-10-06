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
（`USER_ID` 取环境变量，大小写不敏感匹配；`?fallbackip=` 可重复/逗号分隔，每项 `host` 或 `host:port`）。
`USER_ID` 未配置时 Worker **拒绝一切接入**（fail-closed），没有默认占位路径。

出口顺序：**直连原始 host > 客户端 `?fallbackip=` > 动态节点 API（`DYNAMIC_NODES_URL`）>
静态 `FALLBACK_IPS`**（后三级在 `ENABLE_FALLBACK=false` 时整体关闭，动态节点另受
`ENABLE_DYNAMIC_NODES` 控制）。字节计量只覆盖上行，下行依赖运行时缓冲——见 `DEPLOY.md` 已知限制。

### 出口条目里的端口 = L4 覆盖（不是代理协议）

`host:port` 形态里的端口**替换**目标端口，目标地址随之丢弃，之后客户端的字节被原样灌进
`host:port`。所以出口节点必须**自己**从报文里认出真实目的地——靠 TLS SNI、HTTP `Host` 头，
或节点上的「端口 → 固定目标」映射表。**Worker 不做任何握手**，因此 SOCKS5 / HTTP CONNECT
代理不适用（那种代理要求客户端先自报家门 + 报出目标地址，裸 TCP 做不到）。

### `?proxy-all=true` = 强制走 socks5 出口

```
wss://<域名>/<USER_ID>?fallbackip=user:pass@socks.1.2.3.4:1080&proxy-all=true
```

连接级开关（对本次 WebSocket 连接上**所有**流生效），默认 `false`。**v0.1.3 语义**：
设为真值（`1/true/yes/on`，大小写不敏感）时所有流**跳过直连与 L4 回退链**，直接把流量交给
**socks5 代理**——Worker 会与代理完成 SOCKS5 握手（方法协商 / 可选 user:pass 认证 / CONNECT
携带原始目标），然后隧道化。适合「所有流量必须经某 socks5 代理出境」。

- 出口配置 = `?fallbackip=`（此时每项必须是 socks5 配置，格式
  `[socks5h?://][user:pass@]host[:port]`，缺端口默认 1080）+ 环境变量 `SOCKS5_PROXY`；
  客户端条目优先，可多台，首连失败自动试下一个。
- 无任何 socks5 配置时**零拨号**直接回 CLOSE，并记 `?proxy-all=true 但无可用 socks5 出口`。
- ⚠️ **破坏性语义变更**：v0.1.2 的 proxy-all 是「跳过直连仍走 L4 回退链」，v0.1.3 起改为只用
  socks5；若你的 `?fallbackip=` 之前是 L4 覆盖项，在 proxy-all 下会被当作 socks5 服务器连接。
  客户端不传该参数时行为与 v0.1.1 完全一致（非破坏性）。

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
| `scripts/build.mjs` | 构建 snippets 压缩版 + 体积预算；`buildTestable()` 产出测试可加载的模块 |
| `scripts/check-protocol.mjs` | 与 gcm `protocol/message.go` 比对消息类型/头长度，防协议漂移 |
| `test/` | Node 侧替身与 125 条用例（可读版与压缩版跑同一套） |
| `wrangler.toml.example` | Wrangler 配置模板（真实 `wrangler.toml` 不入库） |

## 两种发布产物

| 产物 | 体积 | 用途 |
|---|---|---|
| `worker.js` | 约 33 KiB（gzip 12 KiB） | 常规部署：Dashboard 粘贴、`wrangler deploy` |
| `worker.snippets.min.js` | 约 12 KiB（gzip 5 KiB） | **Cloudflare Snippets** 等对脚本体积有限制的场景 |

压缩版由 `npm run build` 生成（去注释/空白/标识符，并折叠伪装页 HTML 空白；
`cloudflare:sockets` 保持外部导入）。**两者行为完全一致**——CI 用同一套用例同时跑两个产物，
任一行为差异都会让 CI 失败，因此压缩版不是"另写一份"，而是同一份源码的构建结果。

## 测试

```bash
npm run check          # 语法 + 跨仓协议一致性 + 125 条用例（可读版 & 压缩版）
npm run check:syntax   # 仅语法
npm run check:protocol # 仅协议一致性（未检出 gcm 库仓时降级为自检并提示）
npm test               # 仅用例
npm run size           # 构建压缩版并对照体积预算（raw ≤16KiB / gzip ≤6KiB，超限退出码 1）
```

端到端：本地 `wrangler dev` 后用 gcm-cli 指向 `ws://localhost:8787/<USER_ID>` 跑一次代理。

## 版本与发版

- 逐版本变更与升级指引见 [`CHANGELOG.md`](CHANGELOG.md)；协作约束（含**发版铁律：不得未经人工批准自行打 tag 并推送**）见 [`AGENTS.md`](AGENTS.md)。
- **协议变更即破坏性变更**：改消息类型/头格式/出口顺序前，先确认 gcm 库仓与客户端同步方案。
