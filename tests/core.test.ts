/**
 * 核心逻辑回归测试（15 条断言）—— 移植自 Python tests/test_core.py。
 * 用 Node 内置 node:test，零额外依赖。
 * 运行：node --import tsx --test tests/core.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { solve } from "../src/core/solver.js";
import { verify_report } from "../src/core/validator.js";
import { generate_disruptions, simulate_resilience } from "../src/core/resilience.js";
import { replan } from "../src/core/replanner.js";
import { before_tool_call, PermissionDenied } from "../src/core/permissions.js";
import { makePOI, makeDisruption } from "../src/core/models.js";
import { load_pois, load_backup_pool, sample_constraints } from "../src/data/snapshot.js";
import { run } from "../src/agents/workflow.js";

describe("[core] 求解器满足硬约束", () => {
  test("基线约束全通过", () => {
    const pois = load_pois("苏州");
    const it = solve(pois, sample_constraints(), { days: 3 });
    const report = verify_report(it);
    assert.ok(report.all_hard_constraints_met, report.violations.join("; "));
  });
});

describe("[core] 必去景点约束", () => {
  test("必去景点被排入", () => {
    const pois = load_pois("苏州");
    const c = sample_constraints();
    c.must_visit = ["s2"];
    const it = solve(pois, c, { days: 3 });
    const ids = new Set(it.items.map((i) => i.poi.id));
    assert.ok(ids.has("s2"));
  });
});

describe("[core] 幻觉检测（不可信数据源）", () => {
  const pois = load_pois("苏州");
  const it = solve(pois, sample_constraints(), { days: 3 });
  const fake = makePOI({
    id: "fake", name: "不存在的景点", city: "苏州", category: "景点",
    lat: 0, lng: 0, visit_minutes: 60, walking_minutes: 5, source: "llm_invented",
  });
  it.items[0].poi = fake;
  const report = verify_report(it);

  test("伪造数据源被检出", () => {
    assert.ok(!report.all_hard_constraints_met);
  });
  test("幻觉规则失败", () => {
    assert.ok(
      report.violations.some((v) => v.includes("不在可信白名单") || v.includes("llm_invented")),
      report.violations.join("; ")
    );
  });
});

describe("[core] 韧性压力测试", () => {
  const pois = load_pois("苏州");
  const it = solve(pois, sample_constraints(), { days: 3 });
  const disruptions = generate_disruptions(pois);
  const result = simulate_resilience(it, disruptions, verify_report);

  test("扰动集生成", () => assert.ok(disruptions.length >= 3));
  test("韧性分在[0,1]", () => assert.ok(result.resilience_score >= 0 && result.resilience_score <= 1));
  test("有脆弱点报告", () => assert.ok("fragile_points" in result));
});

describe("[core] 重规划最小改动", () => {
  const pois = load_pois("苏州");
  const it = solve(pois, sample_constraints(), { days: 3 });
  const d = makeDisruption({ id: "rain", kind: "weather", description: "下雨", target_poi_ids: ["s1"] });
  const result = replan(it, d, load_backup_pool("苏州"));

  test("重规划返回新行程", () => assert.notEqual(result.new_itinerary, it));
  test("改动节点数可量化", () => assert.equal(typeof result.changed_count, "number"));
  test("有决策说明（可回放）", () => assert.ok(!!result.reason));
});

describe("[core] 权限钩子（受控）", () => {
  test("只读工具放行", () => {
    const d = before_tool_call("search_poi");
    assert.ok(d.allowed && d.level === "read");
  });
  test("可逆写入放行并记录", () => {
    const d = before_tool_call("save_itinerary");
    assert.ok(d.allowed && d.logged === true);
  });
  test("外部动作未批准被拦截", () => {
    assert.throws(() => before_tool_call("book_ticket", undefined, () => false), PermissionDenied);
  });
});

describe("[core] Trace 可回放", () => {
  const { tracer } = run({ city: "苏州", simulate_disruption: "rain" });
  const summary = tracer.summary();

  test("trace 记录多 Agent", () => {
    assert.ok(summary.agents.length >= 4, String(summary.agents));
  });
  test("trace 文件落盘", () => {
    assert.ok(existsSync(tracer.path));
  });
});
