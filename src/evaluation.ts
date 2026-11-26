/**
 * 评估模块 —— 把"评估回归"变成可运行的指标计算。
 * 对应简历指标：约束满足率 / 幻觉率 / 韧性分 / 总花费 / 脆弱点。
 *
 * Python 版 src/evaluation.py 的 TS 重写。
 */
import { validate, TRUSTED_SOURCES, verify_report } from "./core/validator.js";
import * as resilience from "./core/resilience.js";
import type { Itinerary, POI } from "./core/models.js";
import type { ValidatorFn } from "./core/resilience.js";

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

export function evaluate(
  itinerary: Itinerary,
  pois: POI[],
  validator_fn?: ValidatorFn
) {
  const results = validate(itinerary);
  const real = itinerary.items.filter((i) => !i.is_backup);

  const untrusted = real.filter((i) => !TRUSTED_SOURCES.has(i.poi.source)).length;
  const hallucination_rate = real.length ? round4(untrusted / real.length) : 0.0;

  const disruptions = resilience.generate_disruptions(pois);
  const stress = resilience.simulate_resilience(
    itinerary,
    disruptions,
    validator_fn ?? verify_report
  );

  return {
    constraint_pass_rate: results.length
      ? round4(results.filter((r) => r.passed).length / results.length)
      : 1.0,
    hallucination_rate,
    resilience_score: stress.resilience_score,
    total_cost: Math.round(itinerary.total_cost() * 100) / 100,
    item_count: real.length,
    fragile_points: stress.fragile_points,
  };
}
