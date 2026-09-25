# CHANGELOG — gcm-worker

记录 `github.com/v2up-32mb/gcm-worker`（GCM 协议 Cloudflare Worker 服务端）各版本变更与部署指引。

---

## 未发版（main HEAD，待人工批准打 tag）

**Fixed**

- 连接超时/被拒时回收已创建的 socket（此前只放弃等待转试下一个出口，迟到的连接会一直挂到
  isolate 结束）；同时清理超时定时器，成功路径不再遗留存活 `CONNECT_TIMEOUT` 的定时器。
- `parseFallbackEntry` 裸 IPv6 误解析：`::1` 此前被按最后一个冒号拆成 `{host:":", port:1}`，
  会对着垃圾地址发起一次无谓连接；现按裸 IPv6 处理并继承目标端口。
- 目标地址非法（端口非 1..65535 十进制、host 为空）时立即关流，不再带着 `NaN` 端口
  把直连与全部回退逐个试一遍。
- CONNECT 负载缺尾杠 `|` 时按整串解析（此前 `substring(0, -1)` 得空串）。
- 全部出口失败 / 目标地址非法时向客户端回 CLOSE：此前静默关流，客户端只能等自己的超时；
  CLOSE 后同一会话其它流不受影响（客户端可见行为变更，见升级指引）。
- 移除语义重复的 `sendError()`（错误响应本就退化为 CLOSE），三条失败路径统一 `sendClose`。

**Added**

- 45 条 Node 侧用例（`npm test`）：单元（地址/端口解析、环境变量解析）+ 端到端
  （路由/403/426、CONNECT 编舞、提前 flush、超时回收与转试、重复 CONNECT、超限流、
  客户端 CLOSE、短包与未知类型、`?fallbackip` 去重、动态节点拉取/去重/失败降级、WS 关闭回收）。
  同一套用例同时跑在「可读版」与「压缩版」产物上，行为不一致即失败。
- `npm run build` 产出 Cloudflare Snippets 用的压缩版 `dist/worker.snippets.min.js`
  （去注释/空白/标识符；`cloudflare:sockets` 保持外部导入）。

**升级指引**：协议格式、出口顺序、环境变量均未变，客户端无需改动。
行为差异仅两处（均属修复）：① 目标地址非法的 CONNECT 现在会收到 CLOSE 而不是静默无响应；
② `FALLBACK_IPS` / `?fallbackip=` 里的裸 IPv6（如 `2606:4700::1`）现在按 IPv6 地址处理并
继承目标端口，而不是被拆成无效的 `:`:1。建议带端口的 IPv6 一律写成 `[ipv6]:port`。

---

## v0.1.0 — 2026-09-26

**首个版本**（自 gcm 库仓 `worker/` 目录独立建仓；`worker.js` 内容与 gcm `v0.1.1` 字节一致）

**Added**

- 仓库脚手架：README / AGENTS / CHANGELOG 三件套、`package.json`（`npm run check`）、
  `wrangler.toml.example`、`.gitignore`（`wrangler.toml`、`.wrangler/`、`node_modules/` 不入库）。
- `scripts/check-protocol.mjs`：比对 `worker.js` 的 `MSG_TYPE` / `HEADER_LEN` 与 gcm 库仓
  `protocol/message.go`，防止两侧协议漂移（未检出 gcm 库仓时降级为规范自检并提示）。
- CI：`test.yml`（`node --check` + 检出 gcm 库仓后的跨仓协议校验）、
  `release.yml`（tag 触发，发布 `worker.js` / `DEPLOY.md` 附件）。

**Changed / Removed**

- gcm 库仓不再携带 `worker/`，其 release 不再打包 Worker 产物；文档改为指向本仓。

**升级指引**：新部署直接用本仓 release 的 `worker.js`；已在用 gcm `v0.1.1` release 附件的
无需改动（同一份代码），后续 Worker 版本从本仓获取。

---

## 历史（合并自 gcm 库仓 `worker/` 目录）

| gcm commit | 内容 |
|---|---|
| `1e9b213` | 收编 GCM Worker 服务端（`worker.js` + `wrangler.toml` + 部署说明） |
| `1d46331` | 移除 `wrangler.toml`（个人部署配置不入库），更新 `worker.js` 头部注释至当前客户端形态 |

对应 gcm release：`v0.1.1`（gcm `v0.1.0` 早于 `worker/` 目录，release 无 Worker 附件）。
