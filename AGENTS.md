# AGENTS.md — gcm-worker 协作指引

面向在该仓库工作的开发者与 AI agent。采用通用的 `AGENTS.md` 命名
（取代厂商专有命名 `CLAUDE.md`），任何 agent / 编辑器 / 工具均按此约定读取。

## 项目定位

`github.com/v2up-32mb/gcm-worker` 是 **GCM 二进制多路复用协议的 Cloudflare Worker 服务端**，
与 Go 核心库 `github.com/v2up-32mb/gcm`（客户端侧协议实现）是一对服务端/客户端：

```
gcm(Go 核心库: 客户端侧 2 字节头多路复用/连接池/流管理/中继)  ⇄  gcm-worker(本仓: WebSocket → TCP 转发)
                                                  ▲
                              gcm-cli(CLI 壳) / x-client(Android)
```

- 协议规范（消息类型、头格式）的**权威定义**在 gcm 库仓 `protocol/message.go`；本仓是它的服务端实现。
- 本仓版本与 gcm 库版本**独立演进**：日常功能改动无需联动发版，只有协议变更才需要两侧同步。
- 语言/运行时：JavaScript（Workers 运行时，`node --check` 可静态校验），无构建步骤、无运行时 npm 依赖。

## 硬性约束（不得违反）

1. **协议一致性铁律**：消息类型取值（CONNECT=0 / CONNECTED=1 / DATA=2 / CLOSE=3）与 2 字节头
   `[STREAM_ID:1][TYPE:1]` 必须与 gcm 库仓 `protocol/` 一致。任何协议改动都是**破坏性变更**，
   必须先给出 gcm 库仓 + 客户端（gcm-cli / x-client）的同步方案，并在两侧 `CHANGELOG.md`
   标注不兼容点。提交前必须 `npm run check:protocol` 通过（CI 会检出 gcm 库仓强校验）。
2. **协议没有 UDP**：线协议不含 UDP 消息类型（gcm `StreamDialer` 亦不实现 `dialer.UDPDialer`）。
   收到未知消息类型只记 `logError`、**不清理会话**（保持与客户端兼容）；新增类型必须先改 gcm 库仓。
3. **单文件自包含**：`worker.js` 保持单文件、无构建步骤、无运行时 npm 依赖
   （`cloudflare:sockets` 除外）——Dashboard 粘贴部署是首要路径，不要引入打包/多模块构建。
   `package.json` 的依赖仅用于开发期（esbuild、wrangler、测试）。
   **唯一的例外是发布用的压缩产物**：`npm run build` 生成的
   `dist/worker.snippets.min.js`（Cloudflare Snippets 体积受限场景），它是同一份源码的构建结果，
   不参与源码结构，不得手改；改行为一律改 `worker.js` 再重新构建。
   压缩版与可读版跑同一套用例，行为不一致即 CI 失败。
   压缩版体积受 `scripts/build.mjs` 的预算约束（raw ≤16KiB / gzip ≤6KiB），超限 CI 失败——
   新增功能前先 `npm run size` 看余量。
4. **秘密与部署配置不入库**：`wrangler.toml`（账号、域名、`[vars]`）留在本地/Cloudflare 侧，
   仓库只提供 `wrangler.toml.example`。`USER_ID` 等鉴权值绝不入库。
   **`USER_ID` 缺省一律 fail-closed**：不配置就拒绝一切接入（403 伪装页）并记日志，
   不允许再退回任何硬编码占位路径——那等于未鉴权的开放代理。
5. **配置全部来自环境变量**（`env.*`），无硬编码默认值兜底（无可用值时降级为空并记日志）。
   新增配置项：`buildConfigFromEnv` 里加解析（`parseEnvBool`/`parseEnvInt` 带范围钳制）
   + `DEPLOY.md` 环境变量表补一行 + `CHANGELOG.md` 记一笔。
6. **对外接口形态视为契约**：`wss://<域名>/<USER_ID>`（路径小写匹配，不匹配返回 403 伪装页）、
   `?fallbackip=`（可重复/逗号分隔，每项 `host` 或 `host:port`，含 `[ipv6]` 方括号写法）、
   出口顺序 **直连原始 host > 客户端 `?fallbackip` > 动态节点 API > 静态 `FALLBACK_IPS`**。
   改动这些都要进 `CHANGELOG.md` 并标注是否破坏客户端。
7. **行为改动不得悄悄发生**：流生命周期、预注册/乐观建流与早期数据缓存（`pendingBuffer`）、
   超时/重试这类影响客户端行为的变更，一律进 `CHANGELOG.md` 并标注是否破坏性。
8. **日志**：调试日志统一走 `log(scope, msg, enableLogging)` / `logError`，受 `ENABLE_LOGGING` 开关控制，
   不要无条件 `console.log`；`logError` 只用于真实异常与协议异常。
9. **发版铁律（最高优先级）**：**绝不未经人工确认就自行打 tag 并推送**。
   任何发版动作（打 tag、`push --tags`、创建 release）必须先向用户明确汇报版本号与发布内容并获得批准；
   提交/推送日常分支不在此限。

## 发版流程（每个 tag 必修）

1. 代码 + 检查通过：`npm run check` 与 `npm run size` 全绿（语法 + 协议一致性 + 用例 + 体积预算），
   必要时 `wrangler deploy --dry-run`。
2. `CHANGELOG.md` 记入该版本：变更分类 + 升级指引。
3. `README.md` 能力/协议说明同步。
4. **先向用户汇报版本号与发布内容并获批准**，才执行 `git tag` 与 `git push origin main --tags`。
   - 文档类修订若无代码变更，随下一个版本 tag 发布，不重打旧 tag。

## 结构速览

| 文件 | 职责 |
|---|---|
| `worker.js` | Worker 主脚本：路由鉴权、`StreamManager` 多路复用流、出口选路；单文件自包含，头部注释即接入与协议说明 |
| `DEPLOY.md` | 部署方式（Dashboard 粘贴 / Wrangler）与环境变量表 |
| `scripts/build.mjs` | 压缩版构建（snippets）+ 体积预算 + 测试产物构建 |
| `scripts/check-protocol.mjs` | 跨仓协议一致性检查（比对 gcm `protocol/message.go`），CI 强校验入口 |
| `test/` | `cf-sockets-stub.mjs`（socket 替身）、`harness.mjs`（运行时替身与会话驱动）、`worker.test.mjs`（125 条用例） |
| `wrangler.toml.example` | Wrangler 配置模板（真实 `wrangler.toml` 不入库） |
| `package.json` | `check` / `check:syntax` / `check:protocol` / `dev` / `deploy` 脚本 |

## 测试

```bash
npm run check    # 语法 + 跨仓协议 + 用例（可读版 & 压缩版）
npm run size     # 压缩版体积预算
```

端到端（手动）：`npx wrangler dev` + gcm-cli `--worker localhost:8787 --user-id <USER_ID>` 跑通一次代理
（至少覆盖：CONNECT 编舞、DATA 双向转发、CLOSE、多流并发、fallback 选路）。
