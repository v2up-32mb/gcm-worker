# CHANGELOG — gcm-worker

记录 `github.com/v2up-32mb/gcm-worker`（GCM 协议 Cloudflare Worker 服务端）各版本变更与部署指引。

---

## 未发版（main HEAD，待人工批准打 tag）

**Added**

- 从 gcm 库仓 `worker/` 目录独立建仓（内容与 gcm `v0.1.1` 字节一致，git 历史经
  `git subtree split` 保留）。
- 仓库脚手架：README / AGENTS / CHANGELOG 三件套、`package.json`（`npm run check`）、
  `wrangler.toml.example`、`.gitignore`。
- CI：`test.yml`（`node --check` + 跨仓协议一致性）、`release.yml`（tag 触发，发布
  `worker.js` / `DEPLOY.md`）。
- `scripts/check-protocol.mjs`：比对 `worker.js` 的 `MSG_TYPE` / `HEADER_LEN` 与 gcm 库仓
  `protocol/message.go`，防止两侧协议漂移（未检出 gcm 库仓时降级为规范自检并提示）。

**Changed / Removed**

- gcm 库仓不再携带 `worker/`：其 release 不再打包 Worker 产物，改由本仓发版；
  gcm README 指向本仓。

**升级指引**：使用方无动作。老版本（gcm `v0.1.0` / `v0.1.1` release 附件）仍可用；
后续 Worker 版本从本仓 release 获取。

---

## 历史（合并自 gcm 库仓 `worker/` 目录）

| gcm 版本 / commit | 内容 |
|---|---|
| `1e9b213` | 收编 GCM Worker 服务端（`worker.js` + `wrangler.toml` + 部署说明） |
| `1d46331` | 移除 `wrangler.toml`（个人部署配置不入库），更新 `worker.js` 头部注释至当前客户端形态 |

对应 gcm release：`v0.1.1`（gcm `v0.1.0` 早于 `worker/` 目录，release 无 Worker 附件）。
