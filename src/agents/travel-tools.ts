/**
 * pi Agent 的自定义工具集 —— 把核心引擎（solver/validator/resilience/replanner）
 * 暴露为 agent 可调用的 tool。单 agent + 多工具，符合 pi 的极简范式。
 *
 * 工具分级（对应权限钩子 src/core/permissions.ts）：
 *   load_pois / validate_plan / stress_test → read
 *   plan_trip / replan                     → reversible_write
 *   book_ticket                             → external_action（需人工批准）
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { load_pois, list_cities, load_backup_pool } from "../data/snapshot.js";
import { solve } from "../core/solver.js";
import { verify_report } from "../core/validator.js";
import { generate_disruptions, generate_disruptions_extended, simulate_resilience } from "../core/resilience.js";
import { explain_resilience } from "../core/attribution.js";
import { replan } from "../core/replanner.js";
import { getSession, setSession } from "./session.js";
import {
  buildPlanningContext,
  getActivePlanningPreferences,
} from "./planning-preferences.js";

const t = (s: string) => [{ type: "text" as const, text: s }];

function fmt(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 列出支持的城市。 */
export const listCitiesTool: AgentTool = {
  name: "list_cities",
  label: "列出城市",
  description: "列出当前支持规划的城市列表",
  parameters: Type.Object({}),
  execute: async () => {
    const cities = list_cities();
    return {
      content: t(`支持的城市：${cities.join("、")}`),
      details: { cities },
    };
  },
};

/** 加载某城市的 POI 快照。 */
export const loadPoisTool: AgentTool = {
  name: "load_pois",
  label: "加载景点",
  description: "加载指定城市的 POI 快照，返回景点数量和名称列表",
  parameters: Type.Object({
    city: Type.String({ description: "城市名，如 苏州 / 杭州 / 南京", default: "苏州" }),
  }),
  execute: async (_id, params) => {
    const p = params as { city: string };
    const city = p.city || "苏州";
    const pois = load_pois(city);
    const names = pois.map((poi) => poi.name).join("、");
    return {
      content: t(`${city} 共 ${pois.length} 个景点：${names}`),
      details: { city, count: pois.length, names: pois.map((poi) => poi.name) },
    };
  },
};

/** 求解行程（贪心排程器）。 */
export const planTripTool: AgentTool = {
  name: "plan_trip",
  label: "规划行程",
  description: "为指定城市生成一份满足硬约束的行程（贪心排程），并设为当前行程",
  parameters: Type.Object({
    city: Type.String({ description: "城市名", default: "苏州" }),
    days: Type.Number({ description: "天数", default: 3 }),
    budget: Type.Optional(Type.Number({ description: "总预算（元），默认 6000" })),
    group: Type.Optional(
      Type.Array(Type.String(), {
        description: "出行人群标签，如老人、小孩、青年、情侣、朋友",
      }),
    ),
    pace: Type.Optional(
      Type.String({
        description: "行程节奏：relaxed / moderate / tight",
      }),
    ),
    afternoon_indoor: Type.Optional(
      Type.Boolean({ description: "下午是否必须安排室内活动" }),
    ),
    must_have_lunch: Type.Optional(
      Type.Boolean({ description: "是否必须保留午休" }),
    ),
    must_visit: Type.Optional(
      Type.Array(Type.String(), {
        description: "必去景点名称或 POI id",
      }),
    ),
    avoid: Type.Optional(
      Type.Array(Type.String(), {
        description: "尽量避开：高台阶、纯室外、需预约、高消费",
      }),
    ),
  }),
  execute: async (_id, params) => {
    const p = params as {
      city: string;
      days: number;
      budget?: number;
      group?: string[];
      pace?: string;
      afternoon_indoor?: boolean;
      must_have_lunch?: boolean;
      must_visit?: string[];
      avoid?: string[];
    };
    const city = p.city || "苏州";
    const days = p.days || 3;
    const pois = load_pois(city);
    const active = getActivePlanningPreferences();
    const planning = buildPlanningContext(pois, {
      group: p.group ?? active?.group,
      pace: p.pace ?? active?.pace,
      afternoon_indoor: p.afternoon_indoor ?? active?.afternoon_indoor,
      must_have_lunch: p.must_have_lunch ?? active?.must_have_lunch,
      must_visit: p.must_visit ?? active?.must_visit,
      avoid: p.avoid ?? active?.avoid,
      budget: p.budget ?? active?.budget,
    });

    const itinerary = solve(planning.pois, planning.constraints, {
      days,
      label: "agent-plan",
      pace: planning.pace,
    });
    setSession({
      city,
      days,
      pois: planning.pois,
      constraints: planning.constraints,
      itinerary,
    });

    const lines: string[] = [];
    for (let day = 1; day <= days; day++) {
      lines.push(`【第 ${day} 天】`);
      for (const item of itinerary.items_for_day(day)) {
        lines.push(
          `  ${fmt(item.start_minute)} ${item.poi.name}（步行${item.poi.walking_minutes}分，台阶${item.poi.stairs}，¥${Math.round(item.cost)}）`
        );
      }
    }
    return {
      content: t(
        `已生成 ${city} ${days} 天行程，共 ${itinerary.items.length} 项，总花费 ¥${Math.round(itinerary.total_cost())}。\n${lines.join("\n")}`
      ),
      details: {
        city,
        days,
        item_count: itinerary.items.length,
        total_cost: Math.round(itinerary.total_cost()),
        items: itinerary.to_dict().items,
        preferences: {
          group: p.group ?? [],
          pace: p.pace ?? null,
          afternoon_indoor: planning.constraints.require_afternoon_indoor,
          must_have_lunch: planning.constraints.nap_required,
          must_visit: p.must_visit ?? [],
          avoid: p.avoid ?? [],
          budget: planning.constraints.budget_total,
          traveler_count: planning.traveler_count,
          max_stairs_per_item: planning.constraints.max_stairs_per_item,
          max_walking_minutes_per_day:
            planning.constraints.max_walking_minutes_per_day,
          max_items_per_day: planning.constraints.max_items_per_day,
        },
        unresolved_must_visit: planning.unresolved_must_visit,
      },
    };
  },
};

/** 校验当前行程的硬约束。 */
export const validatePlanTool: AgentTool = {
  name: "validate_plan",
  label: "校验行程",
  description: "校验当前行程是否满足所有硬约束（预算/台阶/步行/景点数/下午室内/午休/必去/数据源）",
  parameters: Type.Object({}),
  execute: async () => {
    const session = getSession();
    if (!session.itinerary) throw new Error("当前无行程可校验");
    const report = verify_report(session.itinerary);
    return {
      content: t(
        `约束校验：${report.passed}/${report.total} 通过，满足率 ${Math.round(report.pass_rate * 100)}%。` +
          (report.violations.length ? ` 违规：${report.violations.join("; ")}` : " 全部硬约束通过。")
      ),
      details: report,
    };
  },
};

/** 韧性压力测试 + 因果归因。 */
export const stressTestTool: AgentTool = {
  name: "stress_test",
  label: "韧性压测",
  description: "向当前行程注入扰动集，计算韧性分并给出因果归因（哪些约束被哪条扰动击穿）",
  parameters: Type.Object({
    extended: Type.Optional(Type.Boolean({ description: "是否用 20 条扩展扰动集，默认 false（5 条）" })),
    seed: Type.Optional(Type.Number({ description: "随机种子，默认 42" })),
  }),
  execute: async (_id, params) => {
    const p = params as { extended?: boolean; seed?: number };
    const session = getSession();
    if (!session.itinerary) throw new Error("当前无行程可压测");
    const seed = p.seed ?? 42;
    const disruptions = p.extended
      ? generate_disruptions_extended(session.pois, seed)
      : generate_disruptions(session.pois, seed);
    const stress = simulate_resilience(session.itinerary, disruptions, verify_report);
    const attr = explain_resilience(session.itinerary, disruptions);
    return {
      content: t(
        `韧性压测：${stress.survived}/${stress.total} 条扰动下仍成立，韧性分 ${Math.round(stress.resilience_score * 100)}%。${attr.summary}`
      ),
      details: { ...stress, attribution: attr },
    };
  },
};

/** 抗扰动重规划：对指定扰动做最小改动补位。 */
export const replanTool: AgentTool = {
  name: "replan",
  label: "抗扰动重规划",
  description: "模拟指定扰动发生，对当前行程做最小改动重规划，返回改动节点数和是否需人工确认",
  parameters: Type.Object({
    disruption_id: Type.String({ description: "扰动 id，如 rain / museum_closed，默认 rain", default: "rain" }),
  }),
  execute: async (_id, params) => {
    const p = params as { disruption_id: string };
    const session = getSession();
    if (!session.itinerary) throw new Error("当前无行程可重规划");
    const disruptions = generate_disruptions(session.pois);
    const d = disruptions.find((x) => x.id === p.disruption_id) ?? disruptions[0];
    const result = replan(session.itinerary, d, load_backup_pool(session.city));
    // 重规划后更新当前行程
    setSession({ ...session, itinerary: result.new_itinerary });
    return {
      content: t(
        `${result.reason} 改动节点数: ${result.changed_count}，需人工确认: ${result.need_approval}，重规划后仍满足约束。`
      ),
      details: {
        reason: result.reason,
        changed_count: result.changed_count,
        changed_items: result.changed_items,
        need_approval: result.need_approval,
        added_cost: result.added_cost,
      },
    };
  },
};

/** 外部动作：订票（演示权限钩子——未获人工批准会被 beforeToolCall 拦截）。 */
export const bookTicketTool: AgentTool = {
  name: "book_ticket",
  label: "订票",
  description: "【外部动作】为景点订票，会触发人工确认",
  parameters: Type.Object({
    poi_id: Type.String({ description: "景点 id" }),
    count: Type.Number({ description: "票数", default: 3 }),
  }),
  execute: async (_id, params) => {
    const p = params as { poi_id: string; count: number };
    // 走到这里说明 beforeToolCall 已批准
    return {
      content: t(`已为 ${p.poi_id} 预订 ${p.count} 张票（人工已批准）。`),
      details: { booked: true, poi_id: p.poi_id, count: p.count },
    };
  },
};

/** 全部工具。 */
export const allTravelTools: AgentTool[] = [
  listCitiesTool,
  loadPoisTool,
  planTripTool,
  validatePlanTool,
  stressTestTool,
  replanTool,
  bookTicketTool,
];
