# CHANGELOG — gcm-worker

记录 `github.com/v2up-32mb/gcm-worker`（GCM 协议 Cloudflare Worker 服务端）各版本变更与部署指引。

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

**已知问题（后续版本处理）**

- `tryDial` 连接超时路径未关闭已创建的 `remoteSocket`：超时后仅放弃等待并试下一个出口，
  迟到的 socket 不会被回收（isolate 结束前一直挂着）。修复时需同步确认与客户端的连接语义。

**升级指引**：新部署直接用本仓 release 的 `worker.js`；已在用 gcm `v0.1.1` release 附件的
无需改动（同一份代码），后续 Worker 版本从本仓获取。

---

## 历史（合并自 gcm 库仓 `worker/` 目录）

| gcm commit | 内容 |
|---|---|
| `1e9b213` | 收编 GCM Worker 服务端（`worker.js` + `wrangler.toml` + 部署说明） |
| `1d46331` | 移除 `wrangler.toml`（个人部署配置不入库），更新 `worker.js` 头部注释至当前客户端形态 |

对应 gcm release：`v0.1.1`（gcm `v0.1.0` 早于 `worker/` 目录，release 无 Worker 附件）。
