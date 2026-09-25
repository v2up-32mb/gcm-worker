# CHANGELOG — gcm-worker

记录 `github.com/v2up-32mb/gcm-worker`（GCM 协议 Cloudflare Worker 服务端）各版本变更与部署指引。

---

## 未发版（main HEAD，待人工批准打 tag）

**Fixed（本轮多身份评审驱动）**

- **流按对象身份绑定**：重复 CONNECT 同一 streamId 时，旧的在途拨号不再把 socket 绑到新一代流上
  （此前会双发 CONNECTED、先到的 socket 永不回收、两条 pump 向同一 streamId 推数据）。
  收尾（pump 尾 CLOSE、删表、streamCount）也只作用于自己的流对象，旧代收尾不再误杀同 id 新流。
- **flush 窗口的身份复查**：早期数据 flush 循环里有 await，期间流可能被关闭或被同 id 新 CONNECT 接管；
  现在置位 `tcpConnected` / 发 CONNECTED / 起 pump 之前都会复查身份。
- **建流失败一律回 CLOSE**：写失败、flush 写失败不再依赖 pump 兜底的时序巧合。CLOSE 通知统一收敛到
  `sendCloseFor`：每条流至多一帧，同 streamId 被新一代接管时不发。
- **流关闭即停手**：客户端 CLOSE / WS 关闭后，`createStream` 不再把剩余回退出口逐个拨完；
  在途（尚未就绪）的 socket 立即 close，不占着连接额度等到 `CONNECT_TIMEOUT` 走完。
- **早期数据字节序**：flush 期间到达的客户端 DATA 不再插到未写完的缓存条目中间
  （此前目标端可能收到 `early-1, early-3, early-2`，TLS/HTTP 会判协议错误）。
- **早期数据缓存不可绕过**：空 DATA 帧（payload 0 字节）此前零成本绕过字节上限，
  现每帧额外计入对象开销；超限回 CLOSE + 关流。
- **非二进制消息不再拆会话**：WebSocket 文本帧此前会让 `decoder.decode(string)` 抛 TypeError，
  经 catch 把整条会话（含其它流）一起关掉；现按协议只接受二进制帧，文本帧记日志后忽略。
- **USER_ID 大小写不敏感**：此前只把 `env.USER_ID` 小写化，客户端把 `--user-id` 原样放进路径，
  含大写字母的 ID 即便两端配置一致也永远 403，且无任何日志。

**Added**

- `MAX_PENDING_BYTES`（预连接窗口内每条流缓存的早期数据上限，默认 1MiB，16KiB–8MiB）——
  此前无上限，持有 USER_ID 的客户端可在窗口内无限灌数据撑爆 isolate 内存。
- `MAX_FALLBACK_IPS`（`?fallbackip=` 条数上限，默认 16，1–64）——此前无上限，
  一条 CONNECT 就能把拨号链拉到分钟级并占满流槽位。

**Other**

- 测试台对齐 Workers 真实语义：二进制按 ArrayBuffer 投递（覆盖生产唯一分支）、
  异步 sink（可观察写序竞态）、写/读失败注入、独立模块实例（隔离动态节点 stale 缓存）。
  45 → 87 条用例，压缩版与可读版跑同一套。
- 跨列表去重：回退列表里与直连 host:port 相同的条目不再被重复拨一次。

**升级指引**：协议格式与出口优先级未变，客户端无需改动。行为差异（均为修复方向）：
① 重复 CONNECT 同一 streamId 时，旧的在途拨号被取消，不再发第二个 CONNECTED；
② 建流失败（含写失败、早期数据超限）一律回 CLOSE，客户端快速失败而非等超时；
③ 早期数据超 `MAX_PENDING_BYTES`、`?fallbackip=` 超 `MAX_FALLBACK_IPS` 时流/条目被截断；
④ 文本（非二进制）WebSocket 帧被忽略，不再拆会话；
⑤ `USER_ID` 现大小写不敏感匹配。

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
