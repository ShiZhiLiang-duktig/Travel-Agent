/**
 * hello.ts —— 验证 pi-agent-core 生态能否跑通（无 Key 模式，用 faux provider 预设 LLM 响应）。
 *
 * 这是阶段1的 smoke test：确认 pi 的 Agent 循环、工具调用、事件流能正常工作，
 * 之后再迁移旅行规划的核心逻辑。
 */
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import {
  registerBuiltInApiProviders,
  registerFauxProvider,
  fauxAssistantMessage,
  streamSimple,
  Type,
  getEnvApiKey,
} from "@mariozechner/pi-ai";

// 1. 注册内置 provider（import stream 时会自动注册，这里显式调一次保险）
registerBuiltInApiProviders();

// 2. 检测是否有真实 API Key；无 Key 则用 faux provider 预设响应，保证 demo 能跑
const openaiKey = getEnvApiKey("openai");
let model;
let usingFaux = false;

if (openaiKey) {
  // 有 Key：用真实模型（示例用 gpt-4o-mini，可按需换）
  model = (await import("@mariozechner/pi-ai")).getModel("openai", "gpt-4o-mini");
  console.log("[init] 使用真实模型: openai/gpt-4o-mini");
} else {
  // 无 Key：注册 faux provider，预设 LLM 响应
  usingFaux = true;
  const faux = registerFauxProvider({
    provider: "faux",
    models: [{ id: "faux-model", name: "Faux Travel Model" }],
  });
  // 预设两条响应：第一条触发工具调用，第二条总结
  faux.setResponses([
    // 第一轮：LLM 决定调用 greet 工具
    fauxAssistantMessage([
      {
        type: "toolCall",
        id: "call-1",
        name: "greet",
        arguments: { name: "旅行者" },
      } as any,
    ]),
    // 第二轮：工具返回后，LLM 给最终回复
    fauxAssistantMessage("你好旅行者！我是基于 pi 框架的智能旅行助手，已成功跑通 agent 循环 + 工具调用。"),
  ]);
  model = faux.getModel();
  console.log("[init] 无 API Key，使用 faux provider 预设响应（demo 模式）");
}

// 3. 定义一个工具：问候
const greetTool: AgentTool = {
  name: "greet",
  label: "问候",
  description: "向用户问好，返回问候语",
  parameters: Type.Object({
    name: Type.String({ description: "用户的名字" }),
  }),
  execute: async (_toolCallId, params) => {
    const p = params as { name: string };
    const text = `你好，${p.name}！工具调用成功。`;
    console.log(`  [tool:greet] 执行 → ${text}`);
    return {
      content: [{ type: "text", text }],
      details: { ok: true, name: p.name },
    };
  },
};

// 4. 创建 Agent
const agent = new Agent({
  initialState: {
    systemPrompt: "你是一个智能旅行助手。需要时调用工具。",
    model,
    thinkingLevel: "off",
    messages: [],
    tools: [greetTool],
  },
  streamFn: streamSimple,
  getApiKey: (provider) => getEnvApiKey(provider),
});

// 5. 订阅事件（观察 agent 生命周期）
agent.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
      console.log("[event] agent_start");
      break;
    case "turn_start":
      console.log("[event] turn_start");
      break;
    case "tool_execution_start":
      console.log(`[event] tool_execution_start: ${event.toolName} args=${JSON.stringify(event.args)}`);
      break;
    case "tool_execution_end":
      console.log(`[event] tool_execution_end: ${event.toolName} isError=${event.isError}`);
      break;
    case "message_end":
      const msg = event.message as any;
      const text = msg.content
        ?.filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      if (text) console.log(`[event] message_end: ${text.slice(0, 120)}`);
      break;
    case "agent_end":
      console.log("[event] agent_end");
      break;
  }
});

// 6. 运行
console.log("\n=== 运行 ===");
await agent.prompt("你好，请用 greet 工具向我问好，然后介绍一下你自己。");
await agent.waitForIdle();

console.log("\n=== 完成 ===");
console.log(`usingFaux=${usingFaux}`);
console.log(`最终消息数: ${agent.state.messages.length}`);
