import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const webDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webDir, "..");

/** 需要注入到前端的变量（保底注入空串，避免 import.meta.env.XXX 残留导致运行时白屏） */
const KNOWN_VITE_KEYS = ["VITE_AMAP_KEY", "VITE_AMAP_SECURITY_CODE"];

/**
 * 读取 VITE_ 前缀变量并转成 source.define。
 * 来源优先级（后者非空时覆盖前者）：
 *   1. 仓库根目录 .env —— 与后端共用，推荐统一放这里
 *   2. web/.env —— 可选，前端专用覆盖
 * Rsbuild 默认只注入 PUBLIC_ 前缀，因此必须显式配置。
 */
function loadViteDefine(): Record<string, string> {
  const fromRoot = loadEnv({ cwd: repoRoot, prefixes: ["VITE_"], processEnv: {} });
  const fromWeb = loadEnv({ cwd: webDir, prefixes: ["VITE_"], processEnv: {} });

  const merged: Record<string, string> = {};
  for (const src of [fromRoot.rawPublicVars, fromWeb.rawPublicVars]) {
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === "string" && v.trim()) merged[k] = v;
    }
  }
  for (const k of KNOWN_VITE_KEYS) {
    if (!(k in merged)) merged[k] = "";
  }

  const define: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) {
    define[`import.meta.env.${k}`] = JSON.stringify(v);
  }
  return define;
}

// Rsbuild 配置：React + 开发时把 /api 代理到后端 :8787
export default defineConfig({
  plugins: [pluginReact()],
  source: { define: loadViteDefine() },
  html: { template: "./index.html" },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
  output: {
    distPath: { root: "dist" },
  },
});
