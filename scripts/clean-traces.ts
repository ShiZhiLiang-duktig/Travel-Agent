/**
 * 清理 traces/ 下的运行残留（*.jsonl / *.metrics.json），保留聚合指标。
 *
 * 运行：npm run clean:traces
 * 说明：traces/ 已 gitignore，本脚本只用于交付前把目录恢复干净；
 *       metrics_index.json 是历史指标聚合，保留以便回放。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(ROOT, "traces");

if (!fs.existsSync(dir)) {
  console.log("traces/ 不存在，无需清理");
  process.exit(0);
}

let removed = 0;
for (const name of fs.readdirSync(dir)) {
  if (name === "metrics_index.json") continue;
  if (!/\.(jsonl|metrics\.json)$/.test(name)) continue;
  const p = path.join(dir, name);
  if (fs.statSync(p).isFile()) {
    fs.unlinkSync(p);
    removed++;
  }
}
console.log(`已清理 ${removed} 个运行残留文件（保留 traces/metrics_index.json）`);
