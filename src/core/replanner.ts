/**
 * 抗扰动重规划（Replanner）—— 扰动发生后做最小改动的局部重排。
 *
 * 关键原则：
 * 1. 最小改动：只移除失效项、用备用项补位，不重新生成整份行程
 * 2. 可量化：统计 changed_items，作为"最小改动"的评估指标
 * 3. 高影响动作（新增支出超阈值）需要 HITL 人工确认
 *
 * 已修复并保持不回退的 5 个 bug：
 *   ① 补位不能排室外景点（下雨场景）—— candidates 过滤 outdoor
 *   ② 找不到可补位的天时要 break，避免死循环
 *   ③ 补位时间不能与已有项重叠 —— 从当天最后结束时间起排，且不越过 17:00
 *   ④ 雨天扰动对「半室外 mixed」景点同样生效（纯 indoor 才不受影响），
 *      否则带「下午室内」约束的行程里没有任何纯 outdoor 项，扰动永远空转
 *   ⑤ 补位优先回填被移除项原本所在的天，兑现「仅改动受影响时段」
 *
 * Python 版 src/core/replanner.py 的 TS 重写。
 */
import { type Itinerary, type Disruption, type POI, ItineraryItem } from "./models.js";

export const APPROVAL_COST_THRESHOLD = 150.0;

export interface ReplanResult {
  new_itinerary: Itinerary;
  changed_items: string[];
  changed_count: number;
  need_approval: boolean;
  added_cost: number;
  reason: string;
}

/** 模仿 Python list 的 repr：['a', 'b']，空列表显示为传入的 fallback。 */
function pyListRepr(arr: string[], fallback: string): string {
  if (arr.length === 0) return fallback;
  return "[" + arr.map((s) => `'${s}'`).join(", ") + "]";
}

export function replan(
  itinerary: Itinerary,
  disruption: Disruption,
  backup_pool: POI[]
): ReplanResult {
  const n_people = itinerary.constraints.travelers.length || 1;
  const newIt = itinerary.clone(`${itinerary.label}+replanned(${disruption.id})`);

  const removed: string[] = [];
  const removedDays: number[] = []; // 被移除项原本所在的天，补位时优先回填（最小改动）
  const added: string[] = [];
  const kept_items: ItineraryItem[] = [];

  for (const item of newIt.items) {
    const target_hit = disruption.target_poi_ids.includes(item.poi.id);
    let should_remove = false;

    if (disruption.kind === "closure" && target_hit) {
      should_remove = true;
    } else if (disruption.kind === "weather" && target_hit && item.poi.indoor !== "indoor") {
      should_remove = true;
    } else if (disruption.kind === "mobility" && item.poi.stairs > 15) {
      should_remove = true;
    } else if (disruption.kind === "delay" && target_hit) {
      item.start_minute += disruption.delay_minutes;
    }

    if (should_remove && !item.is_backup) {
      removed.push(item.poi.name);
      removedDays.push(item.day);
    } else {
      kept_items.push(item);
    }
  }

  // 用备用池补位：下雨优先室内；补位不能让某天景点数超限、不能时间重叠
  const n_removed = removed.length;
  if (n_removed > 0) {
    const used_ids = new Set(kept_items.map((i) => i.poi.id));
    const candidates = backup_pool.filter(
      (p) => !used_ids.has(p.id) && (disruption.kind !== "weather" || p.indoor !== "outdoor")
    );
    const max_per_day = itinerary.constraints.max_items_per_day;
    const hasCapacity = (day: number) =>
      kept_items.filter((i) => i.day === day && !i.is_backup).length < max_per_day;

    for (let idx = 0; idx < candidates.length && added.length < n_removed; idx++) {
      const poi = candidates[idx];
      // 优先补回被移除项所在的天，兑现「仅改动受影响时段」；该天已满再找其它天
      let target_day: number | null =
        removedDays[added.length] !== undefined && hasCapacity(removedDays[added.length])
          ? removedDays[added.length]
          : null;
      if (target_day === null) {
        for (let day = 1; day <= itinerary.days; day++) {
          if (hasCapacity(day)) {
            target_day = day;
            break;
          }
        }
      }
      if (target_day === null) break; // bug ②：找不到就停，不死循环

      // bug ③：从当天最后结束时间起排，避免重叠
      const day_items = kept_items.filter((i) => i.day === target_day);
      let last_end = 9 * 60;
      for (const i of day_items) if (i.end_minute > last_end) last_end = i.end_minute;
      const start = Math.max(last_end, 13 * 60);
      if (start + poi.visit_minutes > 17 * 60) continue; // 不越过关门时间

      kept_items.push(
        new ItineraryItem({
          poi,
          day: target_day,
          start_minute: start,
          duration_minutes: poi.visit_minutes,
          poi_source_travelers: itinerary.constraints.travelers,
        })
      );
      added.push(poi.name);
    }
  }

  newIt.items = kept_items;

  const added_cost = backup_pool
    .filter((p) => added.includes(p.name))
    .reduce((s, p) => s + p.price_per_person * n_people, 0);

  return {
    new_itinerary: newIt,
    changed_items: [...removed, ...added],
    changed_count: removed.length + added.length,
    need_approval: added_cost > APPROVAL_COST_THRESHOLD,
    added_cost: Math.round(added_cost * 100) / 100,
    reason: `扰动[${disruption.id}]：移除 ${pyListRepr(removed, "无")}，补入 ${pyListRepr(
      added,
      "无"
    )}；仅改动受影响时段，其余保持不变`,
  };
}
