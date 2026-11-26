/**
 * 约束 DSL —— 把用户自然语言需求形式化为可审计的机器契约。
 *
 * Python 版 src/core/dsl.py 的 TS 重写。
 * 注意：Python 版曾因字段叫 field 覆盖了 dataclasses.field 而报错（已修复为 rule_field），
 * TS 不存在此冲突，这里直接用 field 作属性名，to_dict 输出的 JSON 键名仍是 "field"，与 Python 兼容。
 */
import { writeFileSync } from "node:fs";
import {
  makeConstraints,
  makeTraveler,
  type Constraints,
  type Itinerary,
  type Traveler,
  type ValidationResult,
} from "./models.js";

export const TRUSTED_SOURCES_DEFAULT = new Set([
  "local_snapshot",
  "amap_api",
  "official_venue",
  "weather_api",
]);

/** DSL 单条规则。type 决定其他字段的含义。 */
export interface DSLRule {
  type: string;
  value?: unknown;
  field?: string;
  op?: string;
  poi_ids?: string[];
  window?: string;
  indoor_values?: string[];
  allowed?: string[];
  hotel_before?: string;
}

/** 完整的约束 DSL。 */
export interface ConstraintDSL {
  version: string;
  rules: DSLRule[];
  travelers: Traveler[];
  metadata: Record<string, unknown>;
}

export function dslRuleFromDict(d: Record<string, unknown>): DSLRule {
  return {
    type: d.type as string,
    value: d.value,
    field: (d.field as string) ?? "",
    op: (d.op as string) ?? "",
    poi_ids: (d.poi_ids as string[]) ?? [],
    window: (d.window as string) ?? "",
    indoor_values: (d.indoor_values as string[]) ?? [],
    allowed: (d.allowed as string[]) ?? [],
    hotel_before: (d.hotel_before as string) ?? "",
  };
}

/** 序列化为与 Python 兼容的 dict（省略空值字段）。 */
export function dslRuleToDict(r: DSLRule): Record<string, unknown> {
  const out: Record<string, unknown> = { type: r.type };
  if (r.value !== undefined && r.value !== null) out.value = r.value;
  if (r.field) out.field = r.field;
  if (r.op) out.op = r.op;
  if (r.poi_ids && r.poi_ids.length) out.poi_ids = r.poi_ids;
  if (r.window) out.window = r.window;
  if (r.indoor_values && r.indoor_values.length) out.indoor_values = r.indoor_values;
  if (r.allowed && r.allowed.length) out.allowed = r.allowed;
  if (r.hotel_before) out.hotel_before = r.hotel_before;
  return out;
}

export function constraintDslFromJson(raw: Record<string, unknown>): ConstraintDSL {
  const travelers = ((raw.travelers as Record<string, unknown>[]) ?? [])
    .filter((t) => t && typeof t === "object")
    .map((t) => makeTraveler(t as Partial<Traveler> & { name: string; age: number }));
  return {
    version: (raw.version as string) ?? "1.0",
    rules: ((raw.rules as Record<string, unknown>[]) ?? []).map(dslRuleFromDict),
    travelers,
    metadata: (raw.metadata as Record<string, unknown>) ?? {},
  };
}

export function constraintDslToJson(dsl: ConstraintDSL): Record<string, unknown> {
  return {
    version: dsl.version,
    rules: dsl.rules.map(dslRuleToDict),
    travelers: dsl.travelers,
    metadata: dsl.metadata,
  };
}

export function dumpDsl(dsl: ConstraintDSL, path: string): void {
  writeFileSync(path, JSON.stringify(constraintDslToJson(dsl), null, 2), "utf-8");
}

/** 把 DSL 编译成 Constraints（给 solver 用）。 */
export function dsl_to_constraints(dsl: ConstraintDSL): Constraints {
  const c = makeConstraints({ budget_total: 0, travelers: dsl.travelers });
  for (const rule of dsl.rules) {
    const t = rule.type;
    if (t === "budget_total") {
      c.budget_total = Number(rule.value ?? 0);
    } else if (t === "threshold_per_item" && rule.field === "stairs") {
      c.max_stairs_per_item = Number(rule.value ?? 0);
    } else if (t === "max_per_day" && rule.field === "visit_count") {
      c.max_items_per_day = Number(rule.value ?? 0);
    } else if (t === "walk_budget_per_day") {
      c.max_walking_minutes_per_day = Number(rule.value ?? 0);
    } else if (t === "afternoon_indoor") {
      c.require_afternoon_indoor = true;
    } else if (t === "nap_required") {
      c.nap_required = true;
    } else if (t === "must_visit") {
      c.must_visit = [...(rule.poi_ids ?? [])];
    } else if (t === "avoid_outdoor_if_rain") {
      c.avoid_outdoor_if_rain = Boolean(rule.value);
    }
  }
  if (c.budget_total <= 0) c.budget_total = 6000;
  if (c.max_stairs_per_item <= 0) c.max_stairs_per_item = 20;
  if (c.max_items_per_day <= 0) c.max_items_per_day = 4;
  if (c.max_walking_minutes_per_day <= 0) c.max_walking_minutes_per_day = 90;
  return c;
}

type AssertionFn = (it: Itinerary) => ValidationResult[];

/** 把 DSL 编译成断言函数列表。 */
function compile_assertions(dsl: ConstraintDSL): AssertionFn[] {
  const compiled: AssertionFn[] = [];
  for (const rule of dsl.rules) {
    const t = rule.type;

    if (t === "budget_total") {
      const threshold = Number(rule.value ?? 0);
      compiled.push((it) => [
        {
          rule: "dsl:budget_total",
          passed: it.total_cost() <= threshold,
          detail: `总价 ${Math.round(it.total_cost())} / 上限 ${Math.round(threshold)}`,
        },
      ]);
    } else if (t === "threshold_per_item") {
      const fieldName = rule.field ?? "";
      const op = rule.op || "leq";
      const threshold = Number(rule.value ?? 0);
      compiled.push((it) => {
        const results: ValidationResult[] = [];
        for (const item of it.items) {
          if (item.is_backup) continue;
          const val = (item.poi as unknown as Record<string, unknown>)[fieldName];
          if (val == null) continue;
          const num = Number(val);
          const ok = op === "leq" ? num <= threshold : num >= threshold;
          results.push({
            rule: `dsl:${fieldName}:${item.poi.name}`,
            passed: ok,
            detail: `${fieldName}=${num} ${op} ${threshold}`,
          });
        }
        return results;
      });
    } else if (t === "max_per_day" && rule.field === "visit_count") {
      const threshold = Number(rule.value ?? 0);
      compiled.push((it) => {
        const results: ValidationResult[] = [];
        for (let day = 1; day <= it.days; day++) {
          const n = it.items_for_day(day).length;
          results.push({
            rule: `dsl:max_items_per_day:day${day}`,
            passed: n <= threshold,
            detail: `${n} 个点 / 上限 ${threshold}`,
          });
        }
        return results;
      });
    } else if (t === "walk_budget_per_day") {
      const threshold = Number(rule.value ?? 0);
      compiled.push((it) => {
        const results: ValidationResult[] = [];
        for (let day = 1; day <= it.days; day++) {
          const walk = it.items_for_day(day).reduce((s, i) => s + i.poi.walking_minutes, 0);
          results.push({
            rule: `dsl:walk_budget:day${day}`,
            passed: walk <= threshold,
            detail: `步行 ${walk} 分 / 上限 ${threshold} 分`,
          });
        }
        return results;
      });
    } else if (t === "afternoon_indoor") {
      const allowed = new Set(
        rule.indoor_values && rule.indoor_values.length ? rule.indoor_values : ["indoor", "mixed"]
      );
      compiled.push((it) => {
        const results: ValidationResult[] = [];
        for (const item of it.items) {
          if (item.is_backup) continue;
          const overlaps_afternoon = item.start_minute < 17 * 60 && item.end_minute > 14 * 60;
          if (overlaps_afternoon) {
            const ok = allowed.has(item.poi.indoor);
            results.push({
              rule: `dsl:afternoon_indoor:${item.poi.name}`,
              passed: ok,
              detail: `下午时段 / 室内属性=${item.poi.indoor}`,
            });
          }
        }
        return results;
      });
    } else if (t === "nap_required") {
      compiled.push((it) => {
        const results: ValidationResult[] = [];
        for (let day = 1; day <= it.days; day++) {
          const has_nap = it
            .items_for_day(day)
            .some((i) => i.poi.category === "酒店" && i.start_minute <= 13 * 60);
          results.push({
            rule: `dsl:nap:day${day}`,
            passed: has_nap,
            detail: has_nap ? "有午休时段" : "缺少午休时段",
          });
        }
        return results;
      });
    } else if (t === "must_visit") {
      const must = new Set(rule.poi_ids ?? []);
      compiled.push((it) => {
        const results: ValidationResult[] = [];
        const visited = new Set(it.items.filter((i) => !i.is_backup).map((i) => i.poi.id));
        for (const pid of must) {
          results.push({
            rule: `dsl:must_visit:${pid}`,
            passed: visited.has(pid),
            detail: visited.has(pid) ? "已包含" : `缺失必去景点 ${pid}`,
          });
        }
        return results;
      });
    } else if (t === "source_whitelist") {
      const allowed = rule.allowed && rule.allowed.length ? new Set(rule.allowed) : TRUSTED_SOURCES_DEFAULT;
      compiled.push((it) => {
        const results: ValidationResult[] = [];
        for (const item of it.items) {
          if (item.is_backup) continue;
          const ok = allowed.has(item.poi.source);
          results.push({
            rule: `dsl:source:${item.poi.name}`,
            passed: ok,
            detail: `数据源=${item.poi.source}` + (ok ? "" : "（不在白名单）"),
          });
        }
        return results;
      });
    }
  }
  return compiled;
}

export function run_dsl_assertions(itinerary: Itinerary, dsl: ConstraintDSL): ValidationResult[] {
  const assertions = compile_assertions(dsl);
  const results: ValidationResult[] = [];
  for (const fn of assertions) results.push(...fn(itinerary));
  return results;
}

export function dsl_verify_report(itinerary: Itinerary, dsl: ConstraintDSL) {
  const results = run_dsl_assertions(itinerary, dsl);
  const passed = results.filter((r) => r.passed).length;
  return {
    passed,
    total: results.length,
    pass_rate: results.length ? Math.round((passed / results.length) * 10000) / 10000 : 1.0,
    violations: results.filter((r) => !r.passed).map((r) => r.detail),
    all_hard_constraints_met: results.every((r) => r.passed),
    engine: "dsl",
  };
}

export function constraints_to_dsl(c: Constraints): ConstraintDSL {
  const rules: DSLRule[] = [];
  rules.push({ type: "budget_total", value: c.budget_total });
  rules.push({ type: "threshold_per_item", field: "stairs", op: "leq", value: c.max_stairs_per_item });
  rules.push({ type: "walk_budget_per_day", value: c.max_walking_minutes_per_day });
  rules.push({ type: "max_per_day", field: "visit_count", op: "leq", value: c.max_items_per_day });
  if (c.require_afternoon_indoor) {
    rules.push({ type: "afternoon_indoor", window: "14:00-17:00", indoor_values: ["indoor", "mixed"] });
  }
  if (c.nap_required) {
    rules.push({ type: "nap_required", hotel_before: "13:00" });
  }
  if (c.must_visit.length) {
    rules.push({ type: "must_visit", poi_ids: [...c.must_visit] });
  }
  rules.push({ type: "source_whitelist", allowed: [...TRUSTED_SOURCES_DEFAULT] });
  if (c.avoid_outdoor_if_rain) {
    rules.push({ type: "avoid_outdoor_if_rain", value: true });
  }
  return {
    version: "1.0",
    rules,
    travelers: c.travelers,
    metadata: { source: "constraints_to_dsl" },
  };
}

/** 默认 DSL：和 sample_constraints 对齐。 */
export function default_dsl(): ConstraintDSL {
  return constraintDslFromJson({
    version: "1.0",
    rules: [
      { type: "budget_total", value: 6000 },
      { type: "threshold_per_item", field: "stairs", op: "leq", value: 20 },
      { type: "walk_budget_per_day", value: 90 },
      { type: "max_per_day", field: "visit_count", op: "leq", value: 4 },
      { type: "afternoon_indoor", window: "14:00-17:00", indoor_values: ["indoor", "mixed"] },
      { type: "nap_required", hotel_before: "13:00" },
      { type: "must_visit", poi_ids: ["s2"] },
      { type: "source_whitelist", allowed: ["local_snapshot", "amap_api", "official_venue", "weather_api"] },
      { type: "avoid_outdoor_if_rain", value: true },
    ],
    travelers: [
      { name: "父亲", age: 60, mobility: "slow" },
      { name: "孩子", age: 8, mobility: "child", needs_nap: true },
      { name: "我", age: 32, mobility: "normal" },
    ],
  });
}
