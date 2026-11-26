/**
 * 基于 Pi Agent Runtime 的运行器 —— 让 Web UI 真正驱动 pi 框架的 Agent。
 *
 * 与 src/agents/workflow.ts（确定性引擎，不调 LLM）的区别：
 *   这里走 `createTravelAgent` 创建真实 `@mariozechner/pi-agent-core` Agent，
 *   由模型（或 faux 脚本）自主调度工具（plan_trip / validate_plan / stress_test / replan / book_ticket），
 *   再把 `agent.subscribe` 的生命周期事件映射成前端已消费的 SSE 事件协议。
 *
 * 两种模式都经过真实 Agent Runtime：
 *   - 选中的模型已配置 Key → 真实 LLM 自主决定工具调用顺序与措辞
 *   - 未配置 Key        → faux provider 预设脚本（仍走完整 Agent 循环，事件序列一致）
 *
 * 事件协议与 workflow.ts 保持同构，前端零改动即可消费：
 *   run_started(handleRun) → start → plan → solve → verify → stress → [replan] → [proposal] → [assistant...] → done → metrics → run_completed
 */
import { fauxAssistantMessage } from "@mariozechner/pi-ai";
import { createTravelAgent } from "../agents/travel-agent.js";
import { clearSession, getSession } from "../agents/session.js";
import { Tracer } from "../core/trace.js";
import { verify_report } from "../core/validator.js";
import { generate_disruptions } from "../core/resilience.js";
import { evaluate } from "../evaluation.js";
import { getModelEntry, isModelConfigured, resolveModel } from "./model-registry.js";
import {
  clearActivePlanningPreferences,
  setActivePlanningPreferences,
  type PlanningPreferences,
} from "../agents/planning-preferences.js";

export interface RuntimeRunParams extends PlanningPreferences {
  city: string;
  days: number;
  simulate_disruption?: string | null;
  modelKey?: string;
  /** 用户自然语言需求，会作为 prompt 传给模型（faux 模式用脚本体现关键选择） */
  requirement?: string;
  /** 出行方式（飞机 / 高铁 / 自驾） */
  transport_mode?: "plane" | "train" | "drive";
}

export interface RuntimeRunResult {
  usingFaux: boolean;
  modelLabel: string;
  /** 模型调用失败时的错误信息（已通过 run_failed 事件推给前端） */
  error?: string;
}

/** SSE 事件回调：与 workflow.ts 的 onEvent 同签名 */
export type RuntimeEventHandler = (event: string, agent: string, detail: any) => void;

/** 出行方式 → 中文标签（prompt / faux 脚本共用） */
const MODE_LABEL: Record<string, string> = { plane: "飞机", train: "高铁", drive: "自驾" };

/**
 * 构造 faux 模式的预设脚本：按用户选择的 city/days/disruption 驱动工具调用，
 * 保证无 Key 时也能通过真实 Agent Runtime 跑出完整事件序列并反映用户选择。
 */
function buildFauxScript(params: RuntimeRunParams): any[] {
  const tc = (name: string, args: Record<string, unknown>, id: string) =>
    fauxAssistantMessage([{ type: "toolCall", id, name, arguments: args } as never]);
  const planArgs: Record<string, unknown> = {
    city: params.city,
    days: params.days,
  };
  if (params.budget !== undefined) planArgs.budget = params.budget;
  if (params.group !== undefined) planArgs.group = params.group;
  if (params.pace !== undefined) planArgs.pace = params.pace;
  if (params.afternoon_indoor !== undefined) {
    planArgs.afternoon_indoor = params.afternoon_indoor;
  }
  if (params.must_have_lunch !== undefined) {
    planArgs.must_have_lunch = params.must_have_lunch;
  }
  if (params.must_visit !== undefined) planArgs.must_visit = params.must_visit;
  if (params.avoid !== undefined) planArgs.avoid = params.avoid;

  const script: any[] = [
    tc("plan_trip", planArgs, "call-plan"),
    tc("validate_plan", {}, "call-validate"),
    tc("stress_test", { extended: false }, "call-stress"),
  ];
  if (params.simulate_disruption) {
    script.push(tc("replan", { disruption_id: params.simulate_disruption }, "call-replan"));
  }
  script.push(tc("book_ticket", { poi_id: "s2", count: 3 }, "call-book"));
  const modeLabel = MODE_LABEL[params.transport_mode || ""] || "";
  const groupLabel = params.group?.length ? `出行人群 ${params.group.join("、")}，` : "";
  script.push(
    fauxAssistantMessage(
      `已按${groupLabel}${modeLabel ? `优先${modeLabel}出行，` : ""}完成${params.city} ${params.days} 天行程规划：约束校验通过，韧性压测完成。` +
        (params.simulate_disruption ? `已针对「${params.simulate_disruption}」扰动做了最小改动重规划。` : "") +
        "订票请求因未获人工确认已被权限钩子拦截，行程与预算安全。"
    )
  );
  return script;
}

/**
 * 运行一次 pi Agent Runtime，把生命周期事件实时推给 onEvent。
 * 返回时 agent 已 idle，最终指标也已作为 metrics 事件推送。
 */
export async function runAgentRuntime(
  params: RuntimeRunParams,
  onEvent: RuntimeEventHandler,
): Promise<RuntimeRunResult> {
  clearSession(); // 避免上一次运行的残留行程污染本次
  setActivePlanningPreferences(params);
  const tracer = new Tracer(`pi-rt-${Date.now().toString(16).slice(-8)}`);

  // 统一出口：落 trace + 推送给订阅者
  const emit = (event: string, agent: string, detail: any) => {
    tracer.log(event, agent, detail);
    onEvent(event, agent, detail);
  };

  // 1. 解析模型：已配置 Key → 真实模型；否则 faux（仍走 Agent Runtime）
  const entry = params.modelKey ? getModelEntry(params.modelKey) : undefined;
  let model: any = undefined;
  let apiKey: string | undefined = undefined;
  let usingFaux = false;
  let modelLabel: string;

  if (entry && isModelConfigured(entry)) {
    model = resolveModel(entry);
    apiKey = process.env[entry.apiKeyEnv];
    modelLabel = `${entry.group === "domestic" ? "🇨🇳" : "🌐"} ${entry.label}`;
    console.log(`[runtime] 使用真实模型: ${modelLabel} (${entry.provider}/${entry.modelId})`);
  } else {
    usingFaux = true;
    modelLabel = entry ? `${entry.label}（未配置 Key，回退 faux 脚本）` : "Faux 演示脚本";
    console.log(`[runtime] 无可用模型 Key，使用 faux provider 预设脚本（仍走 pi Agent Runtime）`);
  }

  // 2. 组装给模型的 prompt（真实模型会据此决定工具调用；faux 忽略 prompt 但脚本已对齐选择）
  const requirement =
    params.requirement?.trim() ||
    `带老人小孩去${params.city}玩${params.days}天，预算充足，行程宽松，下午安排室内活动，午休不能省。`;
  const structured =
    `结构化偏好：出行人群=${params.group?.length ? params.group.join("、") : "未指定"}；` +
    `行程节奏=${params.pace ?? "未指定"}；` +
    `出行方式=${MODE_LABEL[params.transport_mode || ""] || "按距离自动推荐"}；` +
    `总预算=${params.budget ? `¥${params.budget}` : "未指定"}；` +
    `下午室内=${params.afternoon_indoor ? "是" : "否"}；` +
    `午休=${params.must_have_lunch ? "必须保留" : "不强制"}；` +
    `必去=${params.must_visit?.length ? params.must_visit.join("、") : "无"}；` +
    `避开=${params.avoid?.length ? params.avoid.join("、") : "无"}。`;
  const prompt =
    `请为以下出行需求做规划：${requirement}（城市=${params.city}，天数=${params.days}）。${structured}` +
    `安排城际段时优先采用所选出行方式，并把往返交通时间计入首日与末日。` +
    `调用 plan_trip 时必须把上述结构化偏好原样作为参数传入，不能只写在自然语言里。` +
    `按工作流调用工具：plan_trip → validate_plan → stress_test` +
    (params.simulate_disruption
      ? `，然后对「${params.simulate_disruption}」扰动调用 replan 做最小改动重规划`
      : "") +
    `。最后总结关键指标。`;

  // 3. 创建 Agent（多模型 / faux 都走这里）
  const { agent } = await createTravelAgent({
    model,
    apiKey,
    tracer,
    approver: () => false, // 外部动作（订票）默认拦截
    fauxScript: usingFaux ? buildFauxScript(params) : undefined,
  });

  emit("start", "Supervisor", {
    city: params.city,
    days: params.days,
    simulate_disruption: params.simulate_disruption ?? null,
    mode: usingFaux ? "pi-runtime:faux" : "pi-runtime:real",
    model: modelLabel,
    preferences: {
      group: params.group ?? [],
      pace: params.pace ?? null,
      afternoon_indoor: params.afternoon_indoor ?? null,
      must_have_lunch: params.must_have_lunch ?? null,
      must_visit: params.must_visit ?? [],
      avoid: params.avoid ?? [],
      budget: params.budget ?? null,
    },
  });

  // 4. 订阅 Agent 生命周期事件 → 映射为前端 SSE 协议
  let planEmitted = false;
  let baselineItinerary: any = null; // solve 阶段的基线行程（replan 会覆盖 session，指标需用基线）
  let modelError: string | null = null; // 模型调用失败（如余额不足/鉴权失败）时的错误信息
  agent.subscribe((event: any) => {
    switch (event.type) {
      case "tool_execution_start":
        if (event.toolName === "plan_trip" && !planEmitted) {
          planEmitted = true;
          emit("plan", "Planner", {
            raw_request:
              `${params.city} ${params.days} 天出行` +
              (params.group?.length ? `（同行：${params.group.join("、")}）` : "") +
              (params.transport_mode ? `，优先${MODE_LABEL[params.transport_mode]}` : "") +
              `（pi Agent 调度 plan_trip）`,
            group: params.group ?? [],
            transport_mode: params.transport_mode ?? null,
            preferences: {
              group: params.group ?? [],
              pace: params.pace ?? null,
              afternoon_indoor: params.afternoon_indoor ?? null,
              must_have_lunch: params.must_have_lunch ?? null,
              must_visit: params.must_visit ?? [],
              avoid: params.avoid ?? [],
              budget: params.budget ?? null,
            },
          });
        }
        break;

      case "tool_execution_end": {
        const details = event.result?.details ?? {};
        switch (event.toolName) {
          case "plan_trip":
            emit("solve", "Solver", {
              item_count: details.item_count,
              total_cost: details.total_cost,
              preferences: details.preferences,
              unresolved_must_visit: details.unresolved_must_visit,
              itinerary: {
                label: "agent-plan",
                days: details.days ?? params.days,
                total_cost: details.total_cost,
                items: details.items ?? [],
              },
            });
            // 记录基线行程（replan 工具会把 session.itinerary 替换为重规划后的）
            try {
              baselineItinerary = getSession().itinerary;
            } catch {
              /* ignore */
            }
            break;
          case "validate_plan":
            emit("verify", "Verifier", details);
            break;
          case "stress_test": {
            // 补充扰动清单（stress 工具 details 里没有，前端展示用）
            let disruptions: any[] = [];
            try {
              const sess = getSession();
              disruptions = generate_disruptions(sess.pois).map((d) => ({
                id: d.id,
                kind: d.kind,
                description: d.description,
              }));
            } catch {
              /* session 未就绪则忽略 */
            }
            emit("stress", "StressTester", { ...details, disruptions });
            break;
          }
          case "replan": {
            // replan 工具 details 缺 post_pass / itinerary，从 session 补齐
            let post_pass: boolean | undefined;
            let itinerary: any = undefined;
            try {
              const sess = getSession();
              if (sess.itinerary) {
                post_pass = verify_report(sess.itinerary).all_hard_constraints_met;
                itinerary = sess.itinerary.to_dict();
              }
            } catch {
              /* ignore */
            }
            emit("replan", "Replanner", {
              disruption: params.simulate_disruption ?? "rain",
              changed_count: details.changed_count,
              changed_items: details.changed_items,
              need_approval: details.need_approval,
              added_cost: details.added_cost,
              post_pass,
              itinerary,
            });
            break;
          }
          case "book_ticket":
            if (event.isError) {
              emit("proposal", "PermissionHook", {
                tool: "book_ticket",
                action_level: "external_action",
                approved: false,
                reason: "外部动作未获人工批准，已拦截",
              });
            }
            break;
        }
        break;
      }

      case "message_end": {
        // 模型调用失败（余额不足 / 鉴权失败 / 网络等）→ pi 会把错误编码进 assistant 消息的 stopReason
        const msg = event.message as {
          role?: string;
          stopReason?: string;
          errorMessage?: string;
          content?: { type: string; text?: string }[];
        };
        if (msg.stopReason === "error" && !modelError) {
          modelError = msg.errorMessage || "模型调用返回错误";
        }
        // 只取模型的真实文本回复（role=assistant），排除 user prompt 回显与 tool result 文本
        if (msg.role && msg.role !== "assistant") break;
        const text = msg.content
          ?.filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("")
          .trim();
        if (text) emit("assistant", "TravelAgent", { text });
        break;
      }

      case "agent_end":
        emit("done", "Supervisor", { iterations: 1 });
        break;
    }
  });

  // 5. 驱动 Agent 运行
  try {
    await agent.prompt(prompt);
    await agent.waitForIdle();
  } finally {
    clearActivePlanningPreferences();
  }

  // 5b. 模型调用失败 → 上报错误，跳过指标（没有有效行程）
  if (modelError) {
    const msg = `模型调用失败：${modelError}`;
    console.warn(`[runtime] ${msg}`);
    emit("run_failed", "Supervisor", { error: msg });
    return { usingFaux, modelLabel, error: modelError };
  }

  // 6. 基于基线行程计算汇总指标（与 demo / workflow 路径口径一致：replan 不改写基线指标）
  try {
    const sess = getSession();
    const itin = baselineItinerary ?? sess.itinerary;
    if (itin && sess.pois) {
      const metrics = evaluate(itin, sess.pois);
      emit("metrics", "Evaluator", metrics);
    }
  } catch (err: any) {
    console.warn("[runtime] 指标计算失败：", err?.message);
  }

  return { usingFaux, modelLabel };
}
