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
  entryPoints: [join(REPO_ROOT, "worker.js")],
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "neutral",
  logLevel: "warning",
};

/** 压缩版（Snippets 用）：去注释、去空白、标识符混淆 */
export async function buildSnippets({ outfile = join(REPO_ROOT, "dist/worker.snippets.min.js"), banner = true } = {}) {
  mkdirSync(dirname(outfile), { recursive: true });
  await build({
    ...base,
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

// CLI：node scripts/build.mjs → 产出 dist/worker.snippets.min.js 并报体积
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await buildSnippets();
  const info = sizeInfo(out);
  console.log(
    `[build] snippets 产物: ${out.replace(`${REPO_ROOT}/`, "")}  原始 ${fmtSize(info.raw)} / gzip ${fmtSize(info.gz)}`,
  );
}
