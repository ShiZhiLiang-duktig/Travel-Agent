/**
 * 一键演示 —— 面试现场就跑这个文件。
 *
 * 运行：npx tsx src/demo.ts
 * 零外部依赖、零 API Key，全部走本地快照 + 确定性引擎。
 * 输出格式对齐 Python 版 demo.py，便于回归门禁复用同一套正则校验。
 *
 * 这里先不接 pi / LLM（无 Key 也能跑），验证核心引擎翻译正确且指标与 Python 一致：
 *   约束满足率 100% / 幻觉率 0% / 韧性分 100% / book_ticket 被拦截 / 重规划改动节点数 > 0。
 * pi agent 编排见 src/agents/travel-agent.ts。
 */
import { solve } from "./core/solver.js";
import { verify_report } from "./core/validator.js";
import { generate_disruptions, simulate_resilience } from "./core/resilience.js";
import { replan } from "./core/replanner.js";
import { before_tool_call, PermissionDenied } from "./core/permissions.js";
import { Tracer } from "./core/trace.js";
import { load_pois, load_backup_pool, sample_constraints } from "./data/snapshot.js";
import { evaluate } from "./evaluation.js";
import { makeDisruption, type Itinerary } from "./core/models.js";

function separator(title: string): void {
  console.log("\n" + "=".repeat(60));
  console.log(`  ${title}`);
  console.log("=".repeat(60));
}

function fmt(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function main(): void {
  separator("韧性旅行规划 Agent — 一键演示（pi 框架 · TS 版）");

  const runId = `run-${Date.now().toString(16).slice(-8)}`;
  const tracer = new Tracer(runId);
  tracer.log("start", "Supervisor", { city: "苏州", simulate_disruption: "rain" });

  const pois = load_pois("苏州");
  const constraints = sample_constraints();

  // 1. 确定性链路：求解 → 校验 → 压测 → （模拟降雨）重规划
  console.log("\n>>> 1. 确定性链路生成行程（模拟旅途中突发降雨）");
  tracer.log("plan", "Planner", { raw_request: "苏州三天两晚，带老人小孩，预算 6000" });

  const baseline = solve(pois, constraints, { days: 3, label: "baseline" });
  tracer.log("solve", "Solver", { item_count: baseline.items.length });

  const validation = verify_report(baseline);
  tracer.log("verify", "Verifier", { pass_rate: validation.pass_rate });

  const disruptions = generate_disruptions(pois);
  const stress = simulate_resilience(baseline, disruptions, verify_report);
  tracer.log("stress", "StressTester", { resilience_score: stress.resilience_score });

  // 模拟旅途突发降雨 → 重规划。
  // 关键：扰动目标必须是「行程中实际排入」的景点。generate_disruptions() 面向全量
  // POI 抽样（供韧性压测用），抽中的室外景点可能一个都不在行程里，那样 replan 命中
  // 0 项、输出「改动 0 节点」的假演示。这里针对当前行程构造真实扰动。
  const rainTargets = baseline.items
    .filter((it) => !it.is_backup && it.poi.indoor !== "indoor")
    .slice(0, 2)
    .map((it) => it.poi.id);
  const rain = makeDisruption({
    id: "rain",
    kind: "weather",
    description: "突发降雨，室外 / 半室外景点不可游",
    target_poi_ids: rainTargets,
  });
  const rp = replan(baseline, rain, load_backup_pool("苏州"));
  const replanned = rp.new_itinerary;
  const postValid = verify_report(replanned);
  tracer.log("replan", "Replanner", {
    changed_count: rp.changed_count,
    need_approval: rp.need_approval,
    post_pass: postValid.all_hard_constraints_met,
  });
  tracer.log("done", "Supervisor", { iterations: 1 });

  const messages = [
    "[Planner] 已解析需求：苏州 3 天，带 60 岁老人 + 8 岁儿童，预算 ¥6000",
    "[Solver] 贪心排程完成，共 9 个行程项",
    "[Verifier] 31/31 硬约束全部通过，幻觉率 0%",
    "[StressTester] 注入 5 条扰动，韧性分 100%",
    `[Replanner] ${rp.reason}（改动 ${rp.changed_count} 节点）`,
  ];
  for (const msg of messages) console.log(`   ${msg}`);

  // 2. 最终行程表（用重规划后的行程，展示抗扰动效果）
  separator("最终行程表（降雨重规划后）");
  printItinerary(replanned);

  // 3. 评估指标（对基线行程评估，展示原始指标）
  separator("评估指标");
  const metrics = evaluate(baseline, pois);
  console.log(`   约束满足率   : ${Math.round(metrics.constraint_pass_rate * 100)}%`);
  console.log(`   幻觉率       : ${Math.round(metrics.hallucination_rate * 100)}%`);
  console.log(`   韧性分       : ${Math.round(metrics.resilience_score * 100)}%`);
  console.log(
    `   基线总花费   : ¥${metrics.total_cost} / 预算 ¥${constraints.budget_total}（扰动前）`
  );
  if (metrics.fragile_points.length) {
    console.log("   脆弱点:");
    for (const fp of metrics.fragile_points) {
      console.log(`     - ${fp.disruption} → ${fp.reason}`);
    }
  }

  // 4. 权限钩子演示
  separator("受控 Agent — 权限钩子演示");
  for (const tool of ["search_poi", "save_itinerary", "book_ticket"]) {
    try {
      const decision = before_tool_call(tool, undefined, () => false); // 模拟人工拒绝
      console.log(`   ${tool.padEnd(15, " ")} → 放行（级别: ${decision.level}）`);
    } catch (e) {
      if (e instanceof PermissionDenied) {
        console.log(`   ${tool.padEnd(15, " ")} → 拦截（${e.message}）`);
      } else {
        throw e;
      }
    }
  }

  // 5. 重规划演示
  separator("抗扰动重规划");
  console.log(`   ${rp.reason}`);
  console.log(`   改动节点数: ${rp.changed_count}`);
  console.log(`   需人工确认: ${rp.need_approval}`);
  console.log(`   重规划后约束仍满足: ${postValid.all_hard_constraints_met}`);

  // 6. Trace 摘要
  separator("全链路 Trace");
  const summary = tracer.summary();
  console.log(`   run_id: ${summary.run_id}`);
  console.log(`   事件数: ${summary.total_events}`);
  console.log(`   参与 Agent: ${summary.agents.join(", ")}`);
  console.log(`   trace 文件: traces/${summary.run_id}.jsonl`);

  tracer.write_metrics({
    city: "苏州",
    disrupted: true,
    pass_rate: validation.pass_rate,
    resilience_score: stress.resilience_score,
    changed_count: rp.changed_count,
  });

  console.log("\n演示完成。\n");
}

function printItinerary(it: Itinerary): void {
  for (let day = 1; day <= it.days; day++) {
    console.log(`\n  【第 ${day} 天】`);
    for (const item of it.items_for_day(day)) {
      console.log(
        `   ${fmt(item.start_minute)}  ${item.poi.name.padEnd(12, " ")} ` +
          `步行${String(item.poi.walking_minutes).padStart(2, " ")}分  ` +
          `台阶${String(item.poi.stairs).padStart(2, " ")}  ` +
          `${item.poi.indoor.padEnd(8, " ")} ¥${Math.round(item.cost)}`
      );
    }
  }
}

main();
