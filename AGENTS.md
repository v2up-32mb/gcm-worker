# AGENTS.md — gcm-worker 协作指引

面向在该仓库工作的开发者与 AI agent。采用通用的 `AGENTS.md` 命名
（取代厂商专有命名 `CLAUDE.md`），任何 agent / 编辑器 / 工具均按此约定读取。

## 项目定位

`github.com/v2up-32mb/gcm-worker` 是 **GCM 二进制多路复用协议的 Cloudflare Worker 服务端**，
与 Go 核心库 `github.com/v2up-32mb/gcm`（客户端侧协议实现）是一对：

```
gcm(Go 核心库: 客户端侧 2 字节头多路复用/连接池/流管理/中继)  ⇄  gcm-worker(服务端: WebSocket → TCP 转发)
                                                  ▲
                              gcm-cli(CLI 壳) / x-client(Android)
```

协议规范（消息类型/头格式）的权威定义在 gcm 库仓 `protocol/message.go`；本仓是它的服务端实现。

## 硬性约束（不得违反）

1. **协议一致性铁律**：消息类型取值（CONNECT=0 / CONNECTED=1 / DATA=2 / CLOSE=3）与 2 字节头
   `[STREAM_ID:1][TYPE:1]` 必须与 gcm 库仓 `protocol/` 一致。任何协议改动都是**破坏性变更**，
   必须先给出 gcm 库仓 + 客户端（gcm-cli / x-client）的同步方案，并在 `CHANGELOG.md`
   标注不兼容点。提交前必须 `npm run check:protocol` 通过。
2. **单文件自包含**：`worker.js` 保持单文件、无构建步骤、无运行时 npm 依赖
   （`cloudflare:sockets` 除外）——Dashboard 粘贴部署是首要路径，不要引入打包/多模块构建。
   `package.json` 里的依赖只用于开发期（wrangler、测试）。
3. **秘密与部署配置不入库**：`wrangler.toml`（账号、域名、`[vars]`）留在本地/Cloudflare 侧，
   仓库只提供 `wrangler.toml.example`。`USER_ID` 等鉴权值绝不入库。
4. **配置全部来自环境变量**（`env.*`），无硬编码默认值兜底（无可用值时降级为空并记日志）。
   新增配置项：`buildConfigFromEnv` 里加解析 + `DEPLOY.md` 环境变量表补一行 + CHANGELOG。
5. **行为改动不得悄悄发生**：出口顺序（直连 > 客户端 `?fallbackip` > 动态节点 > 静态）、
   流生命周期、超时/重试这类影响客户端行为的变更，一律进 `CHANGELOG.md` 并标注是否破坏性。
6. **日志**：调试日志统一走 `log(scope, msg, enableLogging)` / `logError`，受 `ENABLE_LOGGING` 开关控制，
   不要无条件 `console.log`。

## 发版流程（每个 tag 必修）

1. 代码 + 检查通过：`npm run check` 全绿（语法 + 协议一致性），必要时 `wrangler deploy --dry-run`。
2. `CHANGELOG.md` 记入该版本：变更分类 + 升级指引。
3. `README.md` 能力/协议说明同步。
4. **先向用户汇报版本号与发布内容并获批准**，才执行 `git tag` 与 `git push origin main --tags`。
   - 文档类修订若无代码变更，随下一个版本 tag 发布，不重打旧 tag。

## 测试

```bash
npm run check
```

端到端（手动）：`wrangler dev` + gcm-cli `--worker localhost:8787 --user-id <USER_ID>` 跑通一次代理。
