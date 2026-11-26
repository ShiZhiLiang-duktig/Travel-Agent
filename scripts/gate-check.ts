/**
 * 回归门禁 —— 移植自 Python scripts/gate_check.py。
 * 运行：npx tsx scripts/gate-check.ts  （或 npm run gate）
 *
 * 三道关：
 *   1. tsc --noEmit 类型检查
 *   2. 全部测试断言通过（core + resilience + api 集成测试，含 0 失败）
 *   3. demo 输出指标达标（约束>=90% / 幻觉<=10% / 韧性>=95% / book_ticket拦截 / 改动节点>0）
 * 任一关失败 → exit 1。
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

type Step = { name: string; run: () => void };
const failures: string[] = [];

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
}

const steps: Step[] = [
  {
    name: "类型检查 (tsc --noEmit)",
    run: () => {
      const out = sh("npx tsc --noEmit");
      // tsc 无输出且 exit 0 即通过；execSync 非 0 会抛
      if (out && out.trim()) console.log(out.trim());
    },
  },
  {
    name: "测试套件 (core + resilience + api + storage 全量断言)",
    run: () => {
      const out = sh(
        "node --import tsx --test tests/core.test.ts tests/resilience_full.test.ts tests/api.test.ts tests/storage.test.ts tests/route-utils.test.ts tests/preferences.test.ts",
      );
      // Node 22 输出 "# tests 30"，旧版输出 "ℹ tests 30"，两种口径都兼容
      const num = (key: string) => {
        const hit = out.match(new RegExp(`(?:^|\\n)\\s*(?:#|ℹ)\\s+${key}\\s+(\\d+)`));
        return hit ? Number(hit[1]) : key === "fail" ? -1 : 0;
      };
      const tests = num("tests");
      const pass = num("pass");
      const fail = num("fail");
      // 不硬编码具体条数：只要 0 失败、全通过、且总数不低于核心基线 30 即可
      if (fail !== 0 || pass !== tests || tests < 30) {
        throw new Error(`期望全部通过且不少于 30 条，实际 tests=${tests} pass=${pass} fail=${fail}`);
      }
      console.log(
        out
          .split("\n")
          .filter((l) => /^\s*(#|ℹ)\s+(tests|pass|fail|cancelled|skipped|duration_ms)\b/.test(l))
          .join("\n"),
      );
    },
  },
  {
    name: "demo 指标门禁",
    run: () => {
      const out = sh("npx tsx src/demo.ts");

      const passRate = Number((out.match(/约束满足率\s*:\s*(\d+(?:\.\d+)?)%/) ?? [])[1] ?? -1);
      const halluc = Number((out.match(/幻觉率\s*:\s*(\d+(?:\.\d+)?)%/) ?? [])[1] ?? -1);
      const resilience = Number((out.match(/韧性分\s*:\s*(\d+(?:\.\d+)?)%/) ?? [])[1] ?? -1);
      const changedCount = Number((out.match(/改动节点数:\s*(\d+)/) ?? [])[1] ?? -1);
      const blockedLine = out.split("\n").find((l) => l.includes("拦截") && l.includes("book_ticket"));

      const errs: string[] = [];
      if (!(passRate >= 90)) errs.push(`约束满足率 ${passRate}% < 90%`);
      if (!(halluc <= 10)) errs.push(`幻觉率 ${halluc}% > 10%`);
      if (!(resilience >= 95)) errs.push(`韧性分 ${resilience}% < 95%`);
      if (changedCount <= 0) errs.push(`改动节点数 ${changedCount} <= 0`);
      if (!blockedLine) errs.push("未找到 book_ticket 拦截记录");

      if (errs.length) throw new Error(errs.join("; "));
      console.log(`  约束=${passRate}% 幻觉=${halluc}% 韧性=${resilience}% 改动=${changedCount} book_ticket=拦截 ✓`);
    },
  },
];

console.log("=".repeat(60));
console.log("  回归门禁 gate-check");
console.log("=".repeat(60));

for (const step of steps) {
  try {
    console.log(`\n[PASS] 开始：${step.name}`);
    step.run();
    console.log(`[PASS] 通过：${step.name}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[FAIL] 失败：${step.name} —— ${msg}`);
    failures.push(step.name);
  }
}

// 额外：确认 trace 目录有产出（可观测性，缺失不视为失败）
const tracesDir = join(ROOT, "traces");
const metricsFile = join(tracesDir, "metrics_index.json");
try {
  if (existsSync(metricsFile) && readFileSync(metricsFile, "utf-8")) {
    console.log("\n[INFO] traces/metrics_index.json 存在（指标聚合可回放）");
  }
} catch {
  console.log("\n[INFO] traces/metrics_index.json 不可读，跳过（不影响门禁）");
}

console.log("\n" + "=".repeat(60));
if (failures.length === 0) {
  console.log("  ✅ 门禁全部通过，评估达标，可交付");
  console.log("=".repeat(60));
  process.exit(0);
} else {
  console.log(`  ❌ 门禁未通过：${failures.join("、")}`);
  console.log("=".repeat(60));
  process.exit(1);
}
