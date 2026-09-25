#!/usr/bin/env node
// 协议一致性检查：比对 worker.js 的消息类型/头长度与 gcm 库仓 protocol/message.go。
//
// 用法：
//   node scripts/check-protocol.mjs
//   GCM_REPO=/path/to/gcm node scripts/check-protocol.mjs
//
// 行为：
//   1. 与本仓内置的协议规范（protocol/message.go 文档注释同源）比对 —— 不一致即失败；
//   2. 若能定位到 gcm 库仓（$GCM_REPO 或 ../gcm / ../../gcm），再与 Go 源码比对 —— 不一致即失败；
//      定位不到则降级为自检并提示（CI 中会检出 gcm 库仓后运行）。
//
// 退出码：0 一致；1 不一致/无法解析。

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// worker.js 的 MSG_TYPE 键名 → 协议名；顺序即取值约定
const TYPES = [
  ["CONNECT", "CONNECT"],
  ["CONNECTED", "CONNECTED"],
  ["DATA", "DATA"],
  ["CLOSE", "CLOSE"],
];

// 权威规范（gcm protocol/message.go 文档注释）：TYPE 与头长度
const SPEC = { types: { CONNECT: 0, CONNECTED: 1, DATA: 2, CLOSE: 3 }, headerSize: 2 };

// 同一批名字在 Go 源码里的常量名
const GO_CONSTS = {
  CONNECT: "MsgTypeConnect",
  CONNECTED: "MsgTypeConnected",
  DATA: "MsgTypeData",
  CLOSE: "MsgTypeClose",
};

const errors = [];

function parseWorkerJs(src) {
  const msgBlock = src.match(/const\s+MSG_TYPE\s*=\s*\{([\s\S]*?)\}/);
  if (!msgBlock) return { error: "未找到 MSG_TYPE 常量块" };
  const types = {};
  for (const [, key, value] of msgBlock[1].matchAll(/([A-Z_]+)\s*:\s*(\d+)/g)) {
    types[key] = Number(value);
  }
  const header = src.match(/const\s+HEADER_LEN\s*=\s*(\d+)/);
  return { types, headerSize: header ? Number(header[1]) : null };
}

function parseGo(src) {
  const types = {};
  for (const [name, constName] of Object.entries(GO_CONSTS)) {
    const m = src.match(new RegExp(`${constName}\\s*=\\s*(\\d+)`));
    if (m) types[name] = Number(m[1]);
  }
  const header = src.match(/HeaderSize\s*=\s*(\d+)/);
  return { types, headerSize: header ? Number(header[1]) : null };
}

function compare(label, got, want) {
  for (const name of Object.keys(want.types)) {
    const g = got.types?.[name];
    if (g === undefined) {
      errors.push(`${label}: 缺少类型 ${name}（期望 ${want.types[name]}）`);
    } else if (g !== want.types[name]) {
      errors.push(`${label}: ${name} = ${g}，期望 ${want.types[name]}`);
    }
  }
  if (got.headerSize === null) {
    errors.push(`${label}: 缺少头长度常量`);
  } else if (got.headerSize !== want.headerSize) {
    errors.push(`${label}: 头长度 = ${got.headerSize}，期望 ${want.headerSize}`);
  }
}

function findGcmRepo() {
  const candidates = [
    process.env.GCM_REPO,
    join(REPO_ROOT, "..", "gcm"),
    join(REPO_ROOT, "..", "..", "gcm"),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(join(dir, "protocol", "message.go"))) return dir;
  }
  return null;
}

// ---- 1. worker.js vs 内置规范 ----
const workerPath = join(REPO_ROOT, "worker.js");
const worker = parseWorkerJs(readFileSync(workerPath, "utf8"));
if (worker.error) {
  errors.push(`worker.js: ${worker.error}`);
} else {
  compare("worker.js vs 协议规范", worker, SPEC);
}
console.log(
  `[check:protocol] worker.js: ${TYPES.map(([k]) => `${k}=${worker.types?.[k]}`).join(" ")} 头长=${worker.headerSize ?? "?"}（规范：${TYPES.map(([k]) => `${k}=${SPEC.types[k]}`).join(" ")} 头长=${SPEC.headerSize}）`,
);

// ---- 2. worker.js vs gcm protocol/message.go ----
const gcmRepo = findGcmRepo();
if (!gcmRepo) {
  console.log(
    "[check:protocol] 未定位到 gcm 库仓（设 GCM_REPO 或置于 ../gcm），跳过跨仓比对（仅完成规范自检）",
  );
} else {
  const go = parseGo(readFileSync(join(gcmRepo, "protocol", "message.go"), "utf8"));
  if (Object.keys(go.types).length === 0) {
    errors.push(`gcm: ${join(gcmRepo, "protocol/message.go")} 未解析出消息类型常量`);
  } else {
    compare("worker.js vs gcm protocol/message.go", worker, go);
  }
  console.log(
    `[check:protocol] gcm 库仓（${gcmRepo}）: ${TYPES.map(([k]) => `${k}=${go.types[k]}`).join(" ")} 头长=${go.headerSize ?? "?"}`,
  );
}

if (errors.length > 0) {
  console.error("[check:protocol] 协议不一致：");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("[check:protocol] OK：消息类型与头长度一致");
