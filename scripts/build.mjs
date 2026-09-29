// 测试/构建共用的 esbuild 封装。
//
//  - buildSnippets()：产出 Cloudflare Snippets 用的压缩版 dist/worker.snippets.min.js
//  - buildTestable()：把 worker.js 与 cloudflare:sockets 替身一起打成可在 Node 加载的 ESM，
//                     压缩版与可读版各一份，供同一套用例做行为等价验证。

import { build } from "esbuild";
import { readFileSync, mkdirSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function version() {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
}

// 把 `cloudflare:sockets` 指到测试替身
const stubPlugin = {
  name: "cf-sockets-stub",
  setup(b) {
    b.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({
      path: join(REPO_ROOT, "test/cf-sockets-stub.mjs"),
    }));
  },
};

const base = {
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "neutral",
  logLevel: "warning",
};

// 伪装页 HTML 只在 snippets 产物里折叠空白：源码保持可读（Dashboard 粘贴路径不受影响），
// 模板字面量内的空白 esbuild 不会动，这里手动收一遍（约省 0.6KB）
export function collapseFakePage(src) {
  const re = /(const FAKE_PAGE_HTML = `)([\s\S]*?)(`;)/;
  const m = src.match(re);
  if (!m) throw new Error("未找到 FAKE_PAGE_HTML，跳过 HTML 折叠");
  const collapsed = m[2].replace(/\s*\n\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim();
  // 折叠后必须仍是同一个页面（关键锚点在）
  for (const anchor of ["<!DOCTYPE html>", "Access Denied", "not allowed", "</html>"]) {
    if (!collapsed.includes(anchor)) throw new Error(`HTML 折叠后丢失锚点: ${anchor}`);
  }
  return src.replace(re, (_, a, _html, b) => a + collapsed + b);
}

/** 压缩版（Snippets 用）：去注释、去空白、标识符混淆 */
export async function buildSnippets({ outfile = join(REPO_ROOT, "dist/worker.snippets.min.js"), banner = true } = {}) {
  mkdirSync(dirname(outfile), { recursive: true });
  const src = collapseFakePage(readFileSync(join(REPO_ROOT, "worker.js"), "utf8"));
  await build({
    ...base,
    stdin: { contents: src, resolveDir: REPO_ROOT, loader: "js" },
    // cloudflare:sockets 由 Workers 运行时提供，保留 import 语句
    external: ["cloudflare:sockets"],
    minify: true,
    legalComments: "none",
    banner: banner
      ? {
          js: `/*! gcm-worker v${version()} 压缩版(Cloudflare Snippets)；完整版/部署说明见 https://github.com/v2up-32mb/gcm-worker */`,
        }
      : undefined,
    outfile,
  });
  return outfile;
}

/** Node 可加载的测试产物；minify=true 时即压缩等价体 */
export async function buildTestable({ outfile, minify = false }) {
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    ...base,
    entryPoints: [join(REPO_ROOT, "worker.js")],
    platform: "browser",
    minify,
    legalComments: minify ? "none" : "inline",
    plugins: [stubPlugin],
    outfile,
  });
  return outfile;
}

export function sizeInfo(file) {
  const raw = statSync(file).size;
  const gz = gzipSync(readFileSync(file)).length;
  return { file, raw, gz };
}

export function fmtSize(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`;
}

// Snippets 体积预算：超过即 CI 失败。
// 平台硬限为 32KB 总包（Cloudflare 官方：Snippets maximum total package size 32KB，
// 另限 5ms CPU / 2MB 内存）。本预算取平台限的小半（18KiB raw / 7KiB gzip，约 56%/22%），
// 为 5ms 执行窗口与将来新增留余量；v0.1.3 引入 socks5 出口后从 16/6 上调（详见 CHANGELOG）。
export const SIZE_BUDGET_RAW = 18 * 1024;
export const SIZE_BUDGET_GZIP = 7 * 1024;

/** 打印体积表并对照预算；返回是否超限 */
export function reportSize(file) {
  const info = sizeInfo(file);
  const rows = [
    ["源码 worker.js", join(REPO_ROOT, "worker.js")],
    ["snippets（压缩版）", file],
  ];
  for (const [label, f] of rows) {
    const i = sizeInfo(f);
    console.log(`  ${label.padEnd(18)} raw ${fmtSize(i.raw).padStart(9)} / gzip ${fmtSize(i.gz).padStart(9)}`);
  }
  const over = info.raw > SIZE_BUDGET_RAW || info.gz > SIZE_BUDGET_GZIP;
  if (over) {
    console.error(
      `[size] 超预算：snippets raw ${info.raw}B（限 ${SIZE_BUDGET_RAW}B）/ gzip ${info.gz}B（限 ${SIZE_BUDGET_GZIP}B）`,
    );
  } else {
    console.log(
      `[size] 在预算内：raw ${info.raw}/${SIZE_BUDGET_RAW}B，gzip ${info.gz}/${SIZE_BUDGET_GZIP}B`,
    );
  }
  return over;
}

// CLI：node scripts/build.mjs → 产出 dist/worker.snippets.min.js 并报体积；超预算退出码 1
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await buildSnippets();
  const info = sizeInfo(out);
  console.log(
    `[build] snippets 产物: ${out.replace(`${REPO_ROOT}/`, "")}  原始 ${fmtSize(info.raw)} / gzip ${fmtSize(info.gz)}`,
  );
  if (reportSize(out)) process.exit(1);
}
