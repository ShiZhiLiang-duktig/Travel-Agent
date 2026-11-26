/**
 * 韧性压力测试（Stress Test）—— 本项目的差异化核心。
 *
 * 思路：出发前主动向行程注入扰动（下雨/景点关闭/延误/体力不支），
 * 模拟行程是否还能成立，给出"韧性分"和脆弱点报告。
 * 韧性分 = 注入 N 个扰动后仍能通过验证的次数 / N。
 *
 * Python 版 src/core/resilience.py 的 TS 重写。
 * 随机采样用 src/core/rng.ts 的 PyRandom，与 CPython random.Random 字节对齐，
 * 保证 seed 相同 → 扰动集完全相同 → 韧性分可复现。
 */
import { type Itinerary, type Disruption, type StressResult, type POI, makeDisruption } from "./models.js";
import { verify_report } from "./validator.js";
import { PyRandom } from "./rng.js";

/** 验证报告结构（与 validator.verify_report 返回值一致）。 */
export interface VerifyReport {
  passed: number;
  total: number;
  pass_rate: number;
  violations: string[];
  all_hard_constraints_met: boolean;
}
export type ValidatorFn = (it: Itinerary) => VerifyReport;

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/**
 * 把扰动作用到行程上，返回受扰动后的副本（不改原对象）。
 * - closure: 目标景点项移除
 * - mobility: 台阶 > 15 的景点移除
 * - weather: 命中的非室内（室外 / 半室外）景点移除
 * - delay: 命中项的开始时间整体后延
 */
export function apply_disruption(itinerary: Itinerary, d: Disruption): Itinerary {
  const affected = itinerary.clone(`${itinerary.label}+${d.id}`);
  const kept = [];
  for (const item of affected.items) {
    const target_hit = d.target_poi_ids.includes(item.poi.id);
    if (d.kind === "closure" && target_hit) continue;
    if (d.kind === "mobility" && item.poi.stairs > 15) continue;
    if (d.kind === "weather" && target_hit && item.poi.indoor !== "indoor") continue;
    if (d.kind === "delay" && target_hit) {
      item.start_minute += d.delay_minutes;
    }
    kept.push(item);
  }
  affected.items = kept;
  return affected;
}

export interface ResilienceSim {
  resilience_score: number;
  survived: number;
  total: number;
  fragile_points: { disruption: string; reason: string }[];
  details: { id: string; survived: boolean; reason: string }[];
}

/**
 * 对每个扰动做一次仿真，统计韧性分和脆弱点。
 * validator_fn 依赖注入，便于单测和换实现（默认用 verify_report）。
 */
export function simulate_resilience(
  itinerary: Itinerary,
  disruptions: Disruption[],
  validator_fn?: ValidatorFn
): ResilienceSim {
  const results: StressResult[] = [];
  for (const d of disruptions) {
    const perturbed = apply_disruption(itinerary, d);
    const report = validator_fn ? validator_fn(perturbed) : verify_report(perturbed);
    const survived = report.all_hard_constraints_met;
    results.push({
      disruption: d,
      survived,
      reason: !survived ? report.violations.slice(0, 2).join("; ") : "约束仍满足",
      modified_items: perturbed.items.filter((i) => i.is_backup).map((i) => i.poi.name),
    });
  }
  const survived_count = results.filter((r) => r.survived).length;
  return {
    resilience_score: results.length ? round4(survived_count / results.length) : 1.0,
    survived: survived_count,
    total: results.length,
    fragile_points: results
      .filter((r) => !r.survived)
      .map((r) => ({ disruption: r.disruption.description, reason: r.reason })),
    details: results.map((r) => ({
      id: r.disruption.id,
      survived: r.survived,
      reason: r.reason,
    })),
  };
}

/** 基于 POI 列表生成标准扰动集（5 条精简版，demo / 快速测试用）。 */
export function generate_disruptions(pois: POI[], seed = 42): Disruption[] {
  const rng = new PyRandom(seed);
  const outdoor = pois.filter((p) => p.indoor === "outdoor").map((p) => p.id);
  const stairs = pois.filter((p) => p.stairs > 10).map((p) => p.id);
  const sample = (xs: string[], n: number) => rng.sample(xs, Math.min(n, xs.length));

  return [
    makeDisruption({ id: "rain", kind: "weather", description: "突发降雨，室外景点不可游", target_poi_ids: sample(outdoor, 3) }),
    makeDisruption({ id: "museum_closed", kind: "closure", description: "景点临时闭馆", target_poi_ids: sample(outdoor, 1) }),
    makeDisruption({ id: "traffic_jam", kind: "delay", description: "交通拥堵延误 40 分钟", target_poi_ids: sample(outdoor, 2), delay_minutes: 40 }),
    makeDisruption({ id: "elder_tired", kind: "mobility", description: "老人走不动，跳过高台阶景点", target_poi_ids: sample(stairs, 2) }),
    makeDisruption({ id: "queue", kind: "delay", description: "热门景点排队超时 30 分钟", target_poi_ids: sample(outdoor, 1), delay_minutes: 30 }),
  ];
}

/** 扩展扰动集（20 条）—— 覆盖天气/交通/景点/体力/人流 5 个维度，回归门禁用。 */
export function generate_disruptions_extended(pois: POI[], seed = 42): Disruption[] {
  const rng = new PyRandom(seed);
  const outdoor = pois.filter((p) => p.indoor === "outdoor").map((p) => p.id);
  const indoor_pois = pois.filter((p) => p.indoor === "indoor").map((p) => p.id);
  const stairs = pois.filter((p) => p.stairs > 10).map((p) => p.id);
  const all_ids = pois.map((p) => p.id);
  const sample = (xs: string[], n: number) => rng.sample(xs, Math.min(n, xs.length));

  return [
    // 天气类 (4)
    makeDisruption({ id: "rain", kind: "weather", description: "突发降雨，室外景点不可游", target_poi_ids: sample(outdoor, 3) }),
    makeDisruption({ id: "extreme_heat", kind: "weather", description: "38℃ 高温，室外景点体验下降", target_poi_ids: sample(outdoor, 2) }),
    makeDisruption({ id: "smog", kind: "weather", description: "严重雾霾，室外景点视野模糊", target_poi_ids: sample(outdoor, 2) }),
    makeDisruption({ id: "strong_wind", kind: "weather", description: "大风天气，空中/沿河景点危险", target_poi_ids: sample(outdoor, 1) }),

    // 交通类 (5)
    makeDisruption({ id: "traffic_jam", kind: "delay", description: "交通拥堵延误 40 分钟", target_poi_ids: sample(all_ids, 2), delay_minutes: 40 }),
    makeDisruption({ id: "metro_failure", kind: "delay", description: "地铁故障，绕行延误 25 分钟", target_poi_ids: sample(all_ids, 1), delay_minutes: 25 }),
    makeDisruption({ id: "taxi_shortage", kind: "delay", description: "打车难，等待 30 分钟", target_poi_ids: sample(all_ids, 2), delay_minutes: 30 }),
    makeDisruption({ id: "train_delay", kind: "delay", description: "高铁延误 60 分钟，城市间行程受影响", target_poi_ids: sample(all_ids, 1), delay_minutes: 60 }),
    makeDisruption({ id: "bridge_closed", kind: "closure", description: "步行桥封锁，步行路线中断", target_poi_ids: sample(all_ids, 2) }),

    // 景点类 (6)
    makeDisruption({ id: "museum_closed", kind: "closure", description: "景点临时闭馆", target_poi_ids: sample(outdoor, 1) }),
    makeDisruption({ id: "reservation_lost", kind: "closure", description: "预约失效，必须重新排队", target_poi_ids: sample(indoor_pois, 1) }),
    makeDisruption({ id: "equipment_fault", kind: "closure", description: "电梯故障，楼梯景点无法到达", target_poi_ids: sample(stairs, 1) }),
    makeDisruption({ id: "capacity_limit", kind: "crowd", description: "限流，需等 2 小时", target_poi_ids: sample(indoor_pois, 1), delay_minutes: 120 }),
    makeDisruption({ id: "restaurant_closed", kind: "closure", description: "餐厅歇业，午餐安排打乱", target_poi_ids: sample(all_ids, 1) }),
    makeDisruption({ id: "stairs_closed", kind: "closure", description: "景区阶梯维修，封闭入口", target_poi_ids: sample(stairs, 1) }),

    // 体力/人流类 (5)
    makeDisruption({ id: "elder_tired", kind: "mobility", description: "老人走不动，跳过高台阶景点", target_poi_ids: sample(stairs, 2) }),
    makeDisruption({ id: "queue", kind: "delay", description: "热门景点排队超时 30 分钟", target_poi_ids: sample(outdoor, 1), delay_minutes: 30 }),
    makeDisruption({ id: "child_sick", kind: "mobility", description: "孩子突发不适，需回酒店休息", target_poi_ids: [] }),
    makeDisruption({ id: "slippery_surface", kind: "mobility", description: "雨后石板路湿滑，行动困难", target_poi_ids: sample(outdoor, 1) }),
    makeDisruption({ id: "crowded_transit", kind: "crowd", description: "公共交通极端拥挤，轮椅无法通行", target_poi_ids: sample(all_ids, 1), delay_minutes: 20 }),
  ];
}
