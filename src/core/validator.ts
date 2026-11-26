/**
 * 约束验证器（Verifier 的核心）—— "可信数据"的落地点。
 *
 * 设计原则：
 * 1. 独立模块，逐条断言硬约束；不让生成行程的 LLM 自己检查自己（避免确认偏误）
 * 2. 断言的是结构化字段，不是模糊语义
 * 3. 幻觉检测：任何 POI 的 source 不可信 → 直接判失败
 * 4. 预算核算：单价 × 人数，用户拿笔能加总验算
 *
 * Python 版 src/core/validator.py 的 TS 重写。
 */
import { type Itinerary, type ValidationResult } from "./models.js";

// 可信数据源白名单。不在名单内的 source 视为幻觉/编造。
export const TRUSTED_SOURCES = new Set(["local_snapshot", "amap_api", "official_venue", "weather_api"]);

/** 对一份行程执行全部硬约束断言，返回逐条结果。 */
export function validate(itinerary: Itinerary): ValidationResult[] {
  const c = itinerary.constraints;
  const results: ValidationResult[] = [];
  const real_items = itinerary.items.filter((i) => !i.is_backup);

  // 规则 1：数据溯源 —— 幻觉检测的第一道门
  for (const item of real_items) {
    const ok = TRUSTED_SOURCES.has(item.poi.source);
    results.push({
      rule: `source:${item.poi.name}`,
      passed: ok,
      detail: `数据源=${item.poi.source}` + (ok ? "" : "（不在可信白名单，疑似编造）"),
    });
  }

  // 规则 2：预算硬上限
  const total = itinerary.total_cost();
  results.push({
    rule: "budget:total",
    passed: total <= c.budget_total,
    detail: `总价 ${Math.round(total)} / 上限 ${c.budget_total}`,
  });

  // 规则 3：台阶数上限（老人无障碍）
  for (const item of real_items) {
    const ok = item.poi.stairs <= c.max_stairs_per_item;
    results.push({
      rule: `stairs:${item.poi.name}`,
      passed: ok,
      detail: `台阶 ${item.poi.stairs} / 上限 ${c.max_stairs_per_item}`,
    });
  }

  // 规则 4：每日步行时间上限
  for (let day = 1; day <= itinerary.days; day++) {
    const walk = itinerary.items_for_day(day).reduce((s, i) => s + i.poi.walking_minutes, 0);
    results.push({
      rule: `walking:day${day}`,
      passed: walk <= c.max_walking_minutes_per_day,
      detail: `步行 ${walk} 分 / 上限 ${c.max_walking_minutes_per_day} 分`,
    });
  }

  // 规则 5：每日景点数上限（防过度打包）
  for (let day = 1; day <= itinerary.days; day++) {
    const n = itinerary.items_for_day(day).length;
    results.push({
      rule: `packing:day${day}`,
      passed: n <= c.max_items_per_day,
      detail: `${n} 个点 / 上限 ${c.max_items_per_day} 个`,
    });
  }

  // 规则 6：下午必须室内（带老人小孩，下午 14:00-17:00）
  if (c.require_afternoon_indoor) {
    for (const item of real_items) {
      const overlaps_afternoon = item.start_minute < 17 * 60 && item.end_minute > 14 * 60;
      if (overlaps_afternoon) {
        const ok = item.poi.indoor === "indoor" || item.poi.indoor === "mixed";
        results.push({
          rule: `afternoon_indoor:${item.poi.name}`,
          passed: ok,
          detail: `下午时段 / 室内属性=${item.poi.indoor}`,
        });
      }
    }
  }

  // 规则 7：午休时段（带小孩）
  if (c.nap_required) {
    for (let day = 1; day <= itinerary.days; day++) {
      const has_nap = itinerary.items_for_day(day).some(
        (i) => i.poi.category === "酒店" && i.start_minute <= 13 * 60
      );
      results.push({
        rule: `nap:day${day}`,
        passed: has_nap,
        detail: has_nap ? "有午休时段" : "缺少午休时段",
      });
    }
  }

  // 规则 8：必去景点
  const visited = new Set(real_items.map((i) => i.poi.id));
  for (const poi_id of c.must_visit) {
    results.push({
      rule: `must_visit:${poi_id}`,
      passed: visited.has(poi_id),
      detail: visited.has(poi_id) ? "已包含" : "缺失必去景点",
    });
  }

  return results;
}

/** 生成结构化验证报告，供 Verifier Agent 和简历指标使用。 */
export function verify_report(itinerary: Itinerary) {
  const results = validate(itinerary);
  const passed = results.filter((r) => r.passed).length;
  return {
    passed,
    total: results.length,
    pass_rate: results.length ? Math.round((passed / results.length) * 10000) / 10000 : 1.0,
    violations: results.filter((r) => !r.passed).map((r) => r.detail),
    all_hard_constraints_met: results.every((r) => r.passed),
  };
}
