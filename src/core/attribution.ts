/**
 * 因果归因 —— 让"韧性分"不只是一个黑盒数字。
 *
 * 每条扰动 → 因果链 → 归因到具体约束违反 → 扣分分解。
 * 示例输出：
 *   韧性分 95%（扣 5%：预约失效 → 必去约束 -5%）
 *
 * 这不是严格的 DAG 图计算，而是归因链（disruption → POI → constraint）。
 * 面试时能指着说："为什么韧性分是 95%？因为预约失效导致必去景点苏州博物馆不可游，
 * 违反了 must_visit 约束——扣 5%。"
 *
 * Python 版 src/core/resilience_attribution.py 的 TS 重写。
 */
import type { Itinerary, Disruption } from "./models.js";
import { apply_disruption, simulate_resilience } from "./resilience.js";
import { validate, verify_report } from "./validator.js";

/** 约束权重（每条约束类型占韧性分的权重）。 */
export const CONSTRAINT_WEIGHT: Record<string, number> = {
  must_visit: 0.25,
  budget: 0.20,
  stairs: 0.15,
  walking: 0.15,
  afternoon_indoor: 0.10,
  nap: 0.05,
  packing: 0.05,
  source: 0.05,
};

/** 单条因果链：扰动 → POI → 约束。 */
export interface CausalLink {
  disruption_id: string;
  disruption_desc: string;
  affected_poi_ids: string[];
  affected_poi_names: string[];
  violated_constraint_types: string[];
  violated_constraint_details: string[];
  critical_constraint: boolean;
  delta_score: number;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/** 对比扰动前后的行程，识别这条扰动影响了哪些约束。 */
function classify_constraint_violations(
  disrupted_itinerary: Itinerary,
  original_itinerary: Itinerary,
  disruption: Disruption
): CausalLink {
  const orig_ids = new Set(
    original_itinerary.items.filter((i) => !i.is_backup).map((i) => i.poi.id)
  );
  const new_ids = new Set(
    disrupted_itinerary.items.filter((i) => !i.is_backup).map((i) => i.poi.id)
  );
  const removed_ids = [...orig_ids].filter((id) => !new_ids.has(id));

  const name_map = new Map(original_itinerary.items.map((i) => [i.poi.id, i.poi.name]));
  const removed_names = removed_ids.map((pid) => name_map.get(pid) ?? pid);

  const violated_types: string[] = [];
  const violated_details: string[] = [];
  let critical = false;
  const constraints = original_itinerary.constraints;

  // must_visit 检查
  const must_visit_set = new Set(constraints.must_visit);
  const lost_must = removed_ids.filter((id) => must_visit_set.has(id));
  if (lost_must.length) {
    violated_types.push("must_visit");
    violated_details.push(`缺失必去景点: ${lost_must.map((p) => name_map.get(p) ?? p)}`);
    critical = true;
  }

  // 预算超限
  const new_cost = disrupted_itinerary.total_cost();
  if (new_cost > constraints.budget_total) {
    violated_types.push("budget");
    violated_details.push(`预算超限: ${Math.round(new_cost)} / ${Math.round(constraints.budget_total)}`);
  }

  // 移除了下午室内 POI → 可能违反 afternoon_indoor
  if (constraints.require_afternoon_indoor) {
    const indoor_removed = original_itinerary.items.filter(
      (i) => removed_ids.includes(i.poi.id) && ["indoor", "mixed"].includes(i.poi.indoor)
    );
    if (indoor_removed.length) {
      const report = validate(disrupted_itinerary);
      if (report.some((r) => r.rule.startsWith("afternoon_indoor") && !r.passed)) {
        violated_types.push("afternoon_indoor");
        violated_details.push("移除了下午室内 POI，新行程下午时段室外暴露");
      }
    }
  }

  // 计算扣分
  const total_weight = Object.values(CONSTRAINT_WEIGHT).reduce((s, v) => s + v, 0);
  let delta = 0;
  for (const vt of violated_types) {
    delta += (CONSTRAINT_WEIGHT[vt] ?? 0.05) / total_weight;
  }

  return {
    disruption_id: disruption.id,
    disruption_desc: disruption.description,
    affected_poi_ids: [...removed_ids].sort(),
    affected_poi_names: [...removed_names].sort(),
    violated_constraint_types: violated_types,
    violated_constraint_details: violated_details,
    critical_constraint: critical,
    delta_score: round4(delta),
  };
}

/** 韧性归因主入口：返回完整因果链 + 扣分分解。 */
export function explain_resilience(
  itinerary: Itinerary,
  disruptions: Disruption[],
  _baseline_score?: number
) {
  const stress = simulate_resilience(itinerary, disruptions, verify_report);
  const score = stress.resilience_score;

  const links: CausalLink[] = [];
  const constraint_breakdown: Record<
    string,
    { hits: number; total_delta: number; disruptions: string[] }
  > = {};

  const failed_disruptions = stress.details
    .filter((d) => !d.survived)
    .map((detail) => disruptions.find((d) => d.id === detail.id))
    .filter((d): d is Disruption => d !== undefined);

  let total_delta = 0;
  for (const d of failed_disruptions) {
    const disrupted = apply_disruption(itinerary, d);
    const link = classify_constraint_violations(disrupted, itinerary, d);
    links.push(link);
    total_delta += link.delta_score;

    for (const vt of link.violated_constraint_types) {
      if (!constraint_breakdown[vt]) {
        constraint_breakdown[vt] = { hits: 0, total_delta: 0, disruptions: [] };
      }
      constraint_breakdown[vt].hits += 1;
      constraint_breakdown[vt].total_delta += link.delta_score;
      constraint_breakdown[vt].disruptions.push(d.id);
    }
  }

  const parts: string[] = [];
  if (links.length) {
    for (const link of links) {
      let desc = `-${Math.round(link.delta_score * 100)}%: ${link.disruption_id}`;
      if (link.violated_constraint_types.length) {
        desc += ` → ${link.violated_constraint_types.join(",")}`;
      }
      if (link.affected_poi_names.length) {
        desc += ` → ${link.affected_poi_names.slice(0, 3).join(",")}`;
      }
      parts.push(desc);
    }
  }
  const summary_parts = [`韧性分 ${Math.round(score * 100)}%`];
  if (total_delta > 0) {
    summary_parts.push(`（扣 ${Math.round(total_delta * 100)}%：${parts.slice(0, 3).join("; ")}）`);
  }
  const summary = summary_parts.join(" ");

  return {
    resilience_score: score,
    total_disruptions: disruptions.length,
    survived: stress.survived,
    failed: stress.total - stress.survived,
    total_delta_score: round4(total_delta),
    links: links.map((l) => ({
      disruption_id: l.disruption_id,
      disruption_desc: l.disruption_desc,
      affected_poi_ids: l.affected_poi_ids,
      affected_poi_names: l.affected_poi_names,
      violated_constraint_types: l.violated_constraint_types,
      violated_constraint_details: l.violated_constraint_details,
      critical_constraint: l.critical_constraint,
      delta_score: l.delta_score,
    })),
    constraint_breakdown: Object.fromEntries(
      Object.entries(constraint_breakdown).map(([k, v]) => [
        k,
        { hits: v.hits, total_delta: round4(v.total_delta), disruptions: v.disruptions },
      ])
    ),
    summary,
    original_stress: stress,
  };
}
