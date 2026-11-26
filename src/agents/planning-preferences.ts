/**
 * 把前端结构化旅行偏好转换为求解器约束。
 *
 * 这些规则必须由代码落成硬约束，不能只写进 prompt：LLM 可以决定如何表达，
 * 但“几个同行人、能爬多少台阶、每天排几个点、是否午休”等必须可验证。
 */
import {
  makeTraveler,
  type Constraints,
  type POI,
  type Traveler,
} from "../core/models.js";
import { sample_constraints } from "../data/snapshot.js";

export type TravelPace = "relaxed" | "moderate" | "tight";

export interface PlanningPreferences {
  group?: string[];
  pace?: TravelPace | string;
  afternoon_indoor?: boolean;
  must_have_lunch?: boolean;
  must_visit?: string[];
  avoid?: string[];
  budget?: number;
}

export interface PlanningContext {
  pois: POI[];
  constraints: Constraints;
  pace?: TravelPace;
  traveler_count: number;
  unresolved_must_visit: string[];
}

/**
 * 当前运行的偏好快照。pi 工具函数本身无状态，真实模型偶尔会遗漏可选参数；
 * 运行器在这里写入一次，plan_trip 会把它与模型显式传入的参数合并。
 * 现有服务端本来就是单进程单会话，因此与 session.ts 的假设保持一致。
 */
let activePreferences: PlanningPreferences | undefined;

export function setActivePlanningPreferences(
  preferences: PlanningPreferences | undefined,
): void {
  activePreferences = preferences;
}

export function getActivePlanningPreferences(): PlanningPreferences | undefined {
  return activePreferences;
}

export function clearActivePlanningPreferences(): void {
  activePreferences = undefined;
}

const PACE_RULES: Record<
  TravelPace,
  { maxItems: number; maxWalking: number }
> = {
  relaxed: { maxItems: 2, maxWalking: 60 },
  moderate: { maxItems: 3, maxWalking: 90 },
  tight: { maxItems: 4, maxWalking: 120 },
};

function uniqueStrings(values: unknown, limit = 20): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ).slice(0, limit);
}

export function normalizePace(value: unknown): TravelPace | undefined {
  return value === "relaxed" || value === "moderate" || value === "tight"
    ? value
    : undefined;
}

/** 人群标签到同行人的映射；情侣 / 朋友默认按两人估算。 */
export function estimateTravelerCount(group?: string[]): number {
  if (!Array.isArray(group) || group.length === 0) return 1;
  let count = 0;
  for (const tag of group) {
    if (tag === "情侣" || tag === "朋友") count += 2;
    else count += 1;
  }
  return Math.max(1, count);
}

function travelersFromGroup(group?: string[]): Traveler[] | undefined {
  if (group === undefined) return undefined;
  const tags = uniqueStrings(group, 12);
  if (tags.length === 0) return [];

  const out: Traveler[] = [];
  for (const tag of tags) {
    if (tag === "老人") {
      out.push(makeTraveler({ name: "同行老人", age: 65, mobility: "slow" }));
    } else if (tag === "小孩") {
      out.push(
        makeTraveler({
          name: "同行小孩",
          age: 8,
          mobility: "child",
          needs_nap: true,
        }),
      );
    } else if (tag === "情侣") {
      out.push(makeTraveler({ name: "情侣A", age: 28 }));
      out.push(makeTraveler({ name: "情侣B", age: 28 }));
    } else if (tag === "朋友") {
      out.push(makeTraveler({ name: "朋友A", age: 28 }));
      out.push(makeTraveler({ name: "朋友B", age: 28 }));
    } else {
      out.push(makeTraveler({ name: tag || "同行人", age: 28 }));
    }
  }
  return out;
}

/**
 * “尽量避开”转换为候选过滤：
 * - 高台阶 / 纯室外 / 需预约 / 高消费
 * 必去景点优先，不会被避开规则误删；若必去项自身冲突，后续校验会明确报错。
 */
function shouldAvoid(poi: POI, avoid: Set<string>, required: Set<string>): boolean {
  if (required.has(poi.id)) return false;
  if (avoid.has("高台阶") && poi.stairs > 5) return true;
  if (avoid.has("纯室外") && poi.indoor === "outdoor") return true;
  if (avoid.has("需预约") && poi.needs_reservation) return true;
  if (avoid.has("高消费") && poi.price_per_person >= 200) return true;
  return false;
}

/**
 * 生成一次规划实际使用的 POI 池和硬约束。
 * 未传某个偏好字段时保留 sample_constraints 的演示默认值，兼容旧调用方。
 */
export function buildPlanningContext(
  pois: POI[],
  preferences: PlanningPreferences = {},
): PlanningContext {
  const constraints = sample_constraints();
  const group = preferences.group === undefined
    ? undefined
    : uniqueStrings(preferences.group, 12);
  const travelers = travelersFromGroup(group);
  if (travelers !== undefined) constraints.travelers = travelers;

  if (
    typeof preferences.budget === "number" &&
    Number.isFinite(preferences.budget) &&
    preferences.budget > 0
  ) {
    constraints.budget_total = preferences.budget;
  }

  const pace = normalizePace(preferences.pace);
  if (pace) {
    constraints.max_items_per_day = PACE_RULES[pace].maxItems;
    constraints.max_walking_minutes_per_day = PACE_RULES[pace].maxWalking;
  }

  if (group) {
    if (group.includes("老人")) {
      constraints.max_stairs_per_item = Math.min(
        constraints.max_stairs_per_item,
        12,
      );
      constraints.max_walking_minutes_per_day = Math.min(
        constraints.max_walking_minutes_per_day,
        70,
      );
    }
    if (group.includes("小孩")) {
      constraints.max_stairs_per_item = Math.min(
        constraints.max_stairs_per_item,
        15,
      );
    }
  }

  const avoid = new Set(uniqueStrings(preferences.avoid, 12));
  if (avoid.has("高台阶")) {
    constraints.max_stairs_per_item = Math.min(
      constraints.max_stairs_per_item,
      5,
    );
  }

  if (typeof preferences.afternoon_indoor === "boolean") {
    constraints.require_afternoon_indoor = preferences.afternoon_indoor;
  }
  if (typeof preferences.must_have_lunch === "boolean") {
    constraints.nap_required = preferences.must_have_lunch;
  }

  const mustVisitInput = preferences.must_visit === undefined
    ? undefined
    : uniqueStrings(preferences.must_visit, 20);
  let unresolvedMustVisit: string[] = [];
  if (mustVisitInput !== undefined) {
    const requiredIds = new Set<string>();
    unresolvedMustVisit = [];
    for (const wanted of mustVisitInput) {
      const matches = pois.filter((p) => p.id === wanted || p.name === wanted);
      if (matches.length === 0) unresolvedMustVisit.push(wanted);
      for (const match of matches) requiredIds.add(match.id);
    }
    constraints.must_visit = [...requiredIds];
  }

  const required = new Set(constraints.must_visit);
  const filteredPois = avoid.size
    ? pois.filter((poi) => !shouldAvoid(poi, avoid, required))
    : pois;

  return {
    pois: filteredPois,
    constraints,
    pace,
    traveler_count: Math.max(1, constraints.travelers.length),
    unresolved_must_visit: unresolvedMustVisit,
  };
}
