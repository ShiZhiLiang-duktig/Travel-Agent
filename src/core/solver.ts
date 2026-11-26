/**
 * 约束求解器（Solver）—— 用规则/贪心把 POI 排进行程，而不是让 LLM 心算。
 *
 * 关键设计：时间窗、体力预算、地理聚类、预算核算全部是确定性代码。
 * LLM 只负责"选哪些 POI"，"怎么排"交给求解器——这是"受控 Agent"的核心思想。
 *
 * Python 版 src/core/solver.py 的 TS 重写。
 */
import { type POI, type Constraints, Itinerary, ItineraryItem, makePOI } from "./models.js";

// 每天的时间窗（分钟）
const DAY_START = 9 * 60; // 09:00
const LUNCH_START = 12 * 60; // 12:00
const LUNCH_END = 13 * 60; // 13:00
const AFTERNOON_END = 17 * 60; // 17:00

export interface SolveOptions {
  days?: number;
  label?: string;
  /** 节奏影响每天可用时段；未传时保持旧的确定性 demo 行为。 */
  pace?: "relaxed" | "moderate" | "tight";
}

/**
 * 贪心求解：把所有 POI 按约束分配到各天的时间窗。
 *
 * 策略：
 * 1. 必去景点优先
 * 2. 每个景点占一个时段（上午/下午各一个），每天最多 max_items_per_day 个
 * 3. 预算用尽则停止
 * 4. 带午休需求时在中午插入酒店休息
 */
export function solve(
  pois: POI[],
  constraints: Constraints,
  opts: SolveOptions = {}
): Itinerary {
  const days = opts.days ?? 3;
  const label = opts.label ?? "baseline";
  const paceSlots =
    opts.pace === "relaxed"
      ? [DAY_START]
      : opts.pace === "moderate"
        ? [DAY_START, LUNCH_END]
        : opts.pace === "tight"
          ? [DAY_START, LUNCH_END, 15 * 60]
          : null;

  const n_people = constraints.travelers.length || 1;
  // 排序：必去优先 → 价格降序
  const ordered = [...pois].sort((a, b) => {
    const aMust = constraints.must_visit.includes(a.id) ? 0 : 1;
    const bMust = constraints.must_visit.includes(b.id) ? 0 : 1;
    if (aMust !== bMust) return aMust - bMust;
    return b.price_per_person - a.price_per_person;
  });

  const items: ItineraryItem[] = [];
  let budget_left = constraints.budget_total;
  const remaining = [...ordered];

  for (let day = 1; day <= days; day++) {
    // 未指定节奏时沿用原来的“一段 + 可选午休后一段”，避免改变 demo 基线。
    const slots: number[] =
      paceSlots ?? [DAY_START, ...(constraints.nap_required ? [LUNCH_END] : [])];
    let dayWalking = 0;

    for (const slot_start of slots) {
      if (remaining.length === 0) break;
      let placed = false;
      for (const poi of [...remaining]) {
        const cost = poi.price_per_person * n_people;
        if (cost > budget_left) continue;
        if (poi.stairs > constraints.max_stairs_per_item) continue;
        if (
          dayWalking + poi.walking_minutes >
          constraints.max_walking_minutes_per_day
        ) {
          continue;
        }
        const dayItems = items.filter((i) => i.day === day);
        const lastEnd = dayItems.reduce(
          (latest, item) => Math.max(latest, item.end_minute),
          0,
        );
        if (
          lastEnd > 0 &&
          slot_start < lastEnd + poi.walking_minutes
        ) {
          continue;
        }
        // 时间窗检查：上午时段必须在 12 点前结束
        if (slot_start === DAY_START && slot_start + poi.visit_minutes > LUNCH_START) continue;
        // 下午时段必须在 17 点前结束
        if (slot_start >= LUNCH_END && slot_start + poi.visit_minutes > AFTERNOON_END) continue;
        // 下午必须室内
        if (
          slot_start >= LUNCH_END &&
          constraints.require_afternoon_indoor &&
          poi.indoor !== "indoor" &&
          poi.indoor !== "mixed"
        ) continue;

        const item = new ItineraryItem({
          poi,
          day,
          start_minute: slot_start,
          duration_minutes: poi.visit_minutes,
          poi_source_travelers: constraints.travelers,
        });
        items.push(item);
        // 从 remaining 移除
        const idx = remaining.findIndex((p) => p.id === poi.id);
        if (idx >= 0) remaining.splice(idx, 1);
        budget_left -= cost;
        dayWalking += poi.walking_minutes;
        placed = true;
        break;
      }
      if (!placed) continue;
    }

    // 午休：插入一个 0 成本的酒店休息项（不占景点名额）
    if (constraints.nap_required) {
      const nap_poi = makePOI({
        id: "nap", name: "酒店午休", city: ordered[0]?.city ?? "", category: "酒店",
        lat: 0, lng: 0, visit_minutes: 60, walking_minutes: 0,
        indoor: "indoor", price_per_person: 0,
      });
      items.push(new ItineraryItem({
        poi: nap_poi, day, start_minute: LUNCH_START,
        duration_minutes: 60, poi_source_travelers: constraints.travelers,
      }));
    }
  }

  return new Itinerary({ items, constraints, days, label });
}
