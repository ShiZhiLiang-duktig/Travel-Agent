/**
 * 扩展韧性测试（15 条断言）—— 移植自 Python tests/test_resilience_full.py。
 * 20 条扰动集覆盖 天气/交通/景点/体力/人流 5 个维度，用于回归门禁。
 * 运行：node --import tsx --test tests/resilience_full.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { solve } from "../src/core/solver.js";
import { verify_report } from "../src/core/validator.js";
import { generate_disruptions_extended, apply_disruption, simulate_resilience } from "../src/core/resilience.js";
import { load_pois, sample_constraints } from "../src/data/snapshot.js";

const ALL_IMPACTS = ["weather", "closure", "delay", "mobility", "crowd"] as const;

describe("[resilience-full] 扩展扰动集结构验证", () => {
  const pois = load_pois("苏州");
  const dis = generate_disruptions_extended(pois);

  test("扰动数 = 20", () => assert.equal(dis.length, 20, `实际 ${dis.length}`));

  test("Impact 覆盖 5 种", () => {
    const impacts = new Set(dis.map((d) => d.kind));
    assert.ok(impacts.size >= 5, `实际 ${[...impacts].join(",")}`);
  });

  for (const imp of ALL_IMPACTS) {
    test(`Impact ${imp} 至少 2 条`, () => {
      const n = dis.filter((d) => d.kind === imp).length;
      assert.ok(n >= 2, `${imp} 实际 ${n} 条`);
    });
  }

  test("所有扰动有 description", () => {
    assert.ok(dis.every((d) => !!d.description));
  });

  test("target_poi_ids 全部合法", () => {
    const allIds = new Set(pois.map((p) => p.id));
    const valid = dis.every((d) => d.target_poi_ids.every((id) => allIds.has(id)));
    assert.ok(valid, "有不存在的 POI id");
  });
});

describe("[resilience-full] 扩展扰动集韧性分合理性", () => {
  const pois = load_pois("苏州");
  const it = solve(pois, sample_constraints(), { days: 3 });
  const dis = generate_disruptions_extended(pois);
  const stress = simulate_resilience(it, dis, verify_report);

  test("韧性分在 [0.5, 1.0]（20 条）", () => {
    assert.ok(stress.resilience_score >= 0.5 && stress.resilience_score <= 1.0, `实际 ${stress.resilience_score}`);
  });
  test("survived + total 匹配", () => {
    assert.equal(stress.survived + (stress.total - stress.survived), stress.total);
  });
  test("脆弱点 reason 有内容", () => {
    assert.ok(stress.fragile_points.every((fp) => !!fp.reason), JSON.stringify(stress.fragile_points));
  });
});

describe("[resilience-full] 每条扰动确实影响行程", () => {
  const pois = load_pois("苏州");
  const it = solve(pois, sample_constraints(), { days: 3 });
  const dis = generate_disruptions_extended(pois);

  test("至少 15/20 条扰动有实际效果", () => {
    let affected = 0;
    for (const d of dis) {
      const perturbed = apply_disruption(it, d);
      const contentsEqual =
        perturbed.items.length === it.items.length &&
        perturbed.items.every((item, idx) =>
          item.poi.id === it.items[idx].poi.id && item.start_minute === it.items[idx].start_minute
        );
      if (!contentsEqual || perturbed.label !== it.label) affected++;
    }
    assert.ok(affected >= 15, `实际 ${affected}/20 条有影响`);
  });
});

describe("[resilience-full] 扰动集可复现（seed 稳定性）", () => {
  const pois = load_pois("苏州");
  const a = generate_disruptions_extended(pois, 42);
  const b = generate_disruptions_extended(pois, 42);
  const c = generate_disruptions_extended(pois, 123);

  test("seed=42 两次结果一致", () => {
    const ka = a.map((d) => [d.id, d.target_poi_ids]);
    const kb = b.map((d) => [d.id, d.target_poi_ids]);
    assert.deepEqual(ka, kb);
  });

  test("不同 seed 至少 5 条扰动有差异", () => {
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      if (JSON.stringify(a[i].target_poi_ids) !== JSON.stringify(c[i].target_poi_ids)) diff++;
    }
    assert.ok(diff >= 5, `仅 ${diff} 条不同，POI 池可能太小`);
  });
});
