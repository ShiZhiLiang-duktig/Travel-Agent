/**
 * 基于 pi-agent-core 的旅行 Agent 工厂。
 *
 * 设计：单 agent + 多工具（pi 不提供 LangGraph 式状态图，这里用极简范式）。
 * Agent 按系统提示的工作流调用工具：plan_trip → validate_plan → stress_test →（按需）replan。
 * book_ticket 是外部动作，由 beforeToolCall 钩子统一拦截，未获人工批准则 block。
 *
 * 无 API Key 时自动用 faux provider 预设脚本响应，保证 demo 可离线运行；
 * 有 Key 时走真实 LLM，由模型自主决定工具调用顺序。
 */
import { Agent } from "@mariozechner/pi-agent-core";
import {
  registerBuiltInApiProviders,
  registerFauxProvider,
  fauxAssistantMessage,
  streamSimple,
  getEnvApiKey,
  getModel,
  type Model,
} from "@mariozechner/pi-ai";
import { allTravelTools } from "./travel-tools.js";
import { before_tool_call, PermissionDenied, type ActionLevel } from "../core/permissions.js";
import type { Tracer } from "../core/trace.js";

/** 本 agent 工具名 → 动作级别（permissions.ts 的 TOOL_POLICY 是通用映射，这里补全旅行工具）。 */
const TOOL_LEVEL: Record<string, ActionLevel> = {
  list_cities: "read",
  load_pois: "read",
  validate_plan: "read",
  stress_test: "read",
  plan_trip: "reversible_write",
  replan: "reversible_write",
  book_ticket: "external_action",
};

export interface CreateTravelAgentOptions {
  /** 人工审批回调：返回 true 批准外部动作。默认拒绝所有外部动作（安全默认）。 */
  approver?: (toolName: string) => boolean;
  /** 可选：把 agent 生命周期事件写入 trace。 */
  tracer?: Tracer;
  /** 可选：覆盖 faux 模式下的预设响应脚本。 */
  fauxScript?: any[];
  /** 可选：指定真实模型 provider/modelId，默认 openai/gpt-4o-mini。 */
  realModel?: { provider: string; modelId: string };
  /** 可选：传入自定义模型对象（多模型注册中心 resolveModel 得到），配合 apiKey 使用。 */
  model?: Model<any>;
  /** 可选：自定义模型对应的 API Key；与 model 同时提供则走真实模型。 */
  apiKey?: string;
}

/** faux 模式默认脚本：plan → validate → stress → book_ticket（被拦截）→ 总结。 */
function defaultFauxScript() {
  const tc = (name: string, args: Record<string, unknown>, id: string) =>
    fauxAssistantMessage([{ type: "toolCall", id, name, arguments: args } as never]);
  return [
    tc("plan_trip", { city: "苏州", days: 3 }, "call-plan"),
    tc("validate_plan", {}, "call-validate"),
    tc("stress_test", { extended: false }, "call-stress"),
    tc("book_ticket", { poi_id: "s2", count: 3 }, "call-book"),
    fauxAssistantMessage(
      "已为你完成苏州 3 天行程规划：约束 100% 通过，韧性分 100%。" +
        "订票请求因未获人工确认已被权限钩子拦截，行程与预算安全。需要我针对某条扰动做重规划吗？"
    ),
  ];
}

const SYSTEM_PROMPT = `你是一个"韧性旅行规划助手"，基于 pi 框架构建，专为带老人小孩的家庭出行设计。

你的工作流（按顺序调用工具）：
1. plan_trip：为用户指定的城市/天数生成满足硬约束的行程（贪心排程）。
2. validate_plan：校验行程是否满足所有硬约束（预算/台阶/步行/每日景点数/下午室内/午休/必去/数据源可信）。
3. stress_test：注入扰动集计算韧性分，并给出因果归因（哪条扰动击穿了哪个约束）。
4. replan：如果某条扰动让行程失效，做最小改动重规划。

安全规则：
- 只能使用 load_pois 加载的本地可信数据源，绝不编造不存在的景点（反幻觉）。
- book_ticket 是外部动作，必须经人工确认；如果被拦截，告知用户"订票需人工确认"即可，不要重试。
- 回答简洁，先给结论再给关键指标。`;

export async function createTravelAgent(opts: CreateTravelAgentOptions = {}) {
  registerBuiltInApiProviders();

  const approver = opts.approver ?? (() => false); // 默认拒绝外部动作
  let usingFaux = false;
  let faux: ReturnType<typeof registerFauxProvider> | null = null;

  let model;
  if (opts.model && opts.apiKey) {
    // 多模型注册中心传入的自定义模型（国内兼容端点 / 自定义 baseUrl）
    model = opts.model;
    console.log(
      `[travel-agent] 使用真实模型: ${opts.model.provider}/${opts.model.id} (${opts.model.baseUrl ?? "原生"})`,
    );
  } else {
    const key = getEnvApiKey("openai");
    // 过滤占位符（真实密钥一般 ≥ 20 字符），避免被误判为可用而走真实模型报错
    if (key && key.trim().length >= 20) {
      const { provider, modelId } = opts.realModel ?? { provider: "openai", modelId: "gpt-4o-mini" };
      model = getModel(provider as never, modelId);
      console.log(`[travel-agent] 使用真实模型: ${provider}/${modelId}`);
    } else {
      usingFaux = true;
      faux = registerFauxProvider({
        provider: "faux",
        models: [{ id: "faux-travel-model", name: "Faux Travel Model" }],
      });
      faux.setResponses(opts.fauxScript ?? defaultFauxScript());
      model = faux.getModel();
      console.log("[travel-agent] 无 API Key，使用 faux provider 预设脚本（demo 模式）");
    }
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      thinkingLevel: "off",
      messages: [],
      tools: allTravelTools,
    },
    // 固定 temperature=0：相同输入 → 相同行程，避免重复规划结果漂移
    streamFn: (model, context, options) =>
      streamSimple(model, context, { ...options, temperature: 0 }),
    getApiKey: (provider) =>
      opts.model && opts.apiKey ? opts.apiKey : getEnvApiKey(provider),
    // 权限钩子：工具执行前统一拦截
    beforeToolCall: async (ctx) => {
      const toolName = ctx.toolCall.name;
      const level = TOOL_LEVEL[toolName];
      try {
        before_tool_call(toolName, level, approver);
        return undefined; // 放行
      } catch (e) {
        if (e instanceof PermissionDenied) {
          opts.tracer?.log("permission_blocked", "PermissionHook", { tool: toolName, reason: e.message });
          return { block: true, reason: e.message };
        }
        throw e;
      }
    },
  });

  // 事件订阅：把工具执行写入 trace（可选）
  if (opts.tracer) {
    const tracer = opts.tracer;
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        tracer.log(`tool:${event.toolName}`, "TravelAgent", {
          tool: event.toolName,
          isError: event.isError,
          result: event.result,
        });
      } else if (event.type === "agent_end") {
        tracer.log("agent_end", "TravelAgent", { messages: event.messages.length });
      }
    });
  }

  return { agent, usingFaux, faux };
}
