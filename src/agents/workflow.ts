/**
 * 确定性工作流（不接 LLM）—— 对应 Python 版 src/agents/workflow.py 的 run()。
 *
 * 把规划→校验→压测→重规划串成一条链，每步落 trace，返回行程 + tracer。
 * 测试和 demo 都复用它，保证"可回放"。
 */
import type { Itinerary } from "../core/models.js";
import { solve } from "../core/solver.js";
import { verify_report } from "../core/validator.js";
import { generate_disruptions, simulate_resilience } from "../core/resilience.js";
import { replan } from "../core/replanner.js";
import { Tracer } from "../core/trace.js";
import { load_pois, load_backup_pool, sample_constraints } from "../data/snapshot.js";

export interface WorkflowResult {
  itinerary: Itinerary;
  replanned?: Itinerary;
  tracer: Tracer;
  validation_pass: boolean;
  resilience_score: number;
}

export interface WorkflowOptions {
  city?: string;
  days?: number;
  simulate_disruption?: string | null;
  tracer?: Tracer;
  /** 可选：每步事件回调（用于 SSE 实时推送给前端） */
  onEvent?: (event: string, agent: string, detail: any) => void;
}

export function run(opts: WorkflowOptions = {}): WorkflowResult {
  const city = opts.city ?? "苏州";
  const days = opts.days ?? 3;
  const tracer = opts.tracer ?? new Tracer(`wf-${Date.now().toString(16).slice(-8)}`);
  // 统一出口：落 trace + 推送给订阅者（SSE 前端）
  const emit = (event: string, agent: string, detail: any) => {
    tracer.log(event, agent, detail);
    opts.onEvent?.(event, agent, detail);
  };

  emit("start", "Supervisor", { city, days, simulate_disruption: opts.simulate_disruption ?? null });

  const pois = load_pois(city);
  const constraints = sample_constraints();

  emit("plan", "Planner", { raw_request: `${city} ${days} 天家庭出行` });

  const itinerary = solve(pois, constraints, { days, label: "baseline" });
  emit("solve", "Solver", { item_count: itinerary.items.length, itinerary: itinerary.to_dict() });

  const validation = verify_report(itinerary);
  emit("verify", "Verifier", {
    pass_rate: validation.pass_rate,
    all_hard_constraints_met: validation.all_hard_constraints_met,
    passed: validation.passed,
    total: validation.total,
    violations: validation.violations,
  });

  const disruptions = generate_disruptions(pois);
  const stress = simulate_resilience(itinerary, disruptions, verify_report);
  emit("stress", "StressTester", {
    resilience_score: stress.resilience_score,
    survived: stress.survived,
    total: stress.total,
    details: stress.details,
    fragile_points: stress.fragile_points,
    disruptions: disruptions.map((d) => ({ id: d.id, kind: d.kind, description: d.description })),
  });

  let replanned: Itinerary | undefined;
  let replanDetail: any = null;
  if (opts.simulate_disruption) {
    const d = disruptions.find((x) => x.id === opts.simulate_disruption);
    if (d) {
      const rp = replan(itinerary, d, load_backup_pool(city));
      replanned = rp.new_itinerary;
      const post = verify_report(replanned);
      replanDetail = {
        disruption: d.id,
        changed_count: rp.changed_count,
        changed_items: rp.changed_items,
        need_approval: rp.need_approval,
        added_cost: rp.added_cost,
        post_pass: post.all_hard_constraints_met,
        itinerary: replanned.to_dict(),
      };
      emit("replan", "Replanner", replanDetail);
    }
  }

  // 权限演示：外部动作默认被拦截（对应 book_ticket）
  emit("proposal", "PermissionHook", {
    tool: "book_ticket",
    action_level: "external_action",
    approved: false,
    reason: "外部动作未获人工批准，已拦截",
  });

  emit("done", "Supervisor", { iterations: 1 });

  return {
    itinerary,
    replanned,
    tracer,
    validation_pass: validation.all_hard_constraints_met,
    resilience_score: stress.resilience_score,
  };
}
