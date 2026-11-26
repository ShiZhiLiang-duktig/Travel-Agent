/**
 * 旅行偏好必须真正进入求解器约束，而不是只改变 prompt 文案。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { load_pois } from "../src/data/snapshot.js";
import { solve } from "../src/core/solver.js";
import {
  buildPlanningContext,
  estimateTravelerCount,
  setActivePlanningPreferences,
  clearActivePlanningPreferences,
} from "../src/agents/planning-preferences.js";
import { runAgentRuntime } from "../src/server/agent-runtime-run.js";
import { getSession } from "../src/agents/session.js";
import { planTripTool } from "../src/agents/travel-tools.js";

describe("结构化偏好映射", () => {
  test("人群、预算、台阶、午休、下午室内、必去和避开全部生效", () => {
    const pois = load_pois("苏州");
    const planning = buildPlanningContext(pois, {
      group: ["老人", "小孩"],
      pace: "relaxed",
      afternoon_indoor: true,
      must_have_lunch: true,
      must_visit: ["苏州博物馆"],
      avoid: ["高台阶", "纯室外"],
      budget: 2000,
    });

    assert.equal(planning.traveler_count, 2);
    assert.equal(planning.constraints.budget_total, 2000);
    assert.equal(planning.constraints.require_afternoon_indoor, true);
    assert.equal(planning.constraints.nap_required, true);
    assert.equal(planning.constraints.max_stairs_per_item, 5);
    assert.equal(planning.constraints.max_items_per_day, 2);
    assert.deepEqual(planning.constraints.must_visit, ["s2"]);
    assert.ok(planning.pois.some((p) => p.id === "s2"));
    assert.ok(
      planning.pois
        .filter((p) => !planning.constraints.must_visit.includes(p.id))
        .every((p) => p.indoor !== "outdoor"),
      "避开纯室外后，不应再排入非必去室外项",
    );
  });

  test("宽松与紧凑节奏产生不同的每日景点数量", () => {
    const pois = load_pois("苏州");
    const relaxed = buildPlanningContext(pois, {
      group: ["青年"],
      pace: "relaxed",
      must_visit: [],
    });
    const tight = buildPlanningContext(pois, {
      group: ["青年"],
      pace: "tight",
      must_visit: [],
    });
    const relaxedItinerary = solve(relaxed.pois, relaxed.constraints, {
      days: 3,
      pace: relaxed.pace,
    });
    const tightItinerary = solve(tight.pois, tight.constraints, {
      days: 3,
      pace: tight.pace,
    });
    assert.ok(
      tightItinerary.items.length > relaxedItinerary.items.length,
      `紧凑=${tightItinerary.items.length}，宽松=${relaxedItinerary.items.length}`,
    );
  });

  test("情侣 / 朋友按两人估算费用人数", () => {
    assert.equal(estimateTravelerCount(["青年"]), 1);
    assert.equal(estimateTravelerCount(["情侣"]), 2);
    assert.equal(estimateTravelerCount(["青年", "朋友"]), 3);
  });

  test("模型遗漏参数时，plan_trip 仍合并本次运行偏好", async () => {
    setActivePlanningPreferences({
      group: ["老人"],
      pace: "tight",
      afternoon_indoor: true,
      must_have_lunch: false,
      must_visit: ["苏州博物馆"],
      avoid: ["高台阶"],
      budget: 1600,
    });
    try {
      await planTripTool.execute("fallback", {
        city: "苏州",
        days: 2,
      } as any);
      const session = getSession();
      assert.equal(session.constraints.budget_total, 1600);
      assert.equal(session.constraints.require_afternoon_indoor, true);
      assert.equal(session.constraints.nap_required, false);
      assert.equal(session.constraints.max_stairs_per_item, 5);
      assert.deepEqual(session.constraints.must_visit, ["s2"]);
    } finally {
      clearActivePlanningPreferences();
    }
  });
});

describe("faux Agent 链路传递结构化偏好", () => {
  test("plan_trip 实际收到偏好并生成对应约束", async () => {
    const events: { event: string; detail?: any }[] = [];
    await runAgentRuntime(
      {
        city: "苏州",
        days: 3,
        group: ["老人", "小孩"],
        pace: "relaxed",
        afternoon_indoor: true,
        must_have_lunch: true,
        must_visit: ["苏州博物馆"],
        avoid: ["高台阶"],
        budget: 1800,
      },
      (event, _agent, detail) => events.push({ event, detail }),
    );

    const plan = events.find((e) => e.event === "plan");
    assert.ok(plan, "应产生 plan 事件");
    assert.equal(plan.detail.preferences.pace, "relaxed");

    const session = getSession();
    assert.equal(session.constraints.budget_total, 1800);
    assert.equal(session.constraints.require_afternoon_indoor, true);
    assert.equal(session.constraints.nap_required, true);
    assert.equal(session.constraints.max_stairs_per_item, 5);
    assert.deepEqual(session.constraints.must_visit, ["s2"]);
    assert.ok(
      session.itinerary?.items.some((item) => item.poi.name === "苏州博物馆"),
      "必去景点应实际排入行程",
    );
  });
});
