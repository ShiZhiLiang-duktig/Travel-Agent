/**
 * pi Agent 端到端演示入口。
 * 运行：npx tsx src/agents/run-pi.ts
 *
 * 无 API Key 时走 faux 脚本：plan → validate → stress → book_ticket(拦截) → 总结。
 * 设置 OPENAI_API_KEY 后走真实模型，由 LLM 自主调度工具。
 */
import { createTravelAgent } from "./travel-agent.js";
import { Tracer } from "../core/trace.js";

const tracer = new Tracer(`pi-run-${Date.now().toString(16).slice(-8)}`);
tracer.log("start", "Supervisor", { engine: "pi-agent-core" });

const { agent, usingFaux } = await createTravelAgent({
  tracer,
  // 演示：外部动作（订票）一律需人工确认，这里模拟"用户尚未确认"→ 拒绝
  approver: () => false,
});

agent.subscribe((event) => {
  switch (event.type) {
    case "tool_execution_start":
      console.log(`  ▶ 调用工具: ${event.toolName}  args=${JSON.stringify(event.args)}`);
      break;
    case "tool_execution_end":
      console.log(`  ◀ 工具结束: ${event.toolName}  error=${event.isError}`);
      break;
    case "message_end": {
      const msg = event.message as { content?: { type: string; text?: string }[] };
      const text = msg.content?.filter((c) => c.type === "text").map((c) => c.text).join("");
      if (text) console.log(`  💬 Agent: ${text.slice(0, 160)}`);
      break;
    }
    case "agent_end":
      console.log("  ■ agent 结束");
      break;
  }
});

console.log("\n=== pi Agent 运行 ===");
await agent.prompt("我想去苏州玩 3 天，带老人和小孩，预算 6000，帮我规划一下，看看韧性如何。");
await agent.waitForIdle();

console.log("\n=== Trace 摘要 ===");
const s = tracer.summary();
console.log(`run_id: ${s.run_id}`);
console.log(`事件数: ${s.total_events}`);
console.log(`trace 文件: traces/${s.run_id}.jsonl`);
console.log(`usingFaux: ${usingFaux}`);
console.log(`最终消息数: ${agent.state.messages.length}`);
