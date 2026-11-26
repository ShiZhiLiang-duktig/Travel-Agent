/**
 * 多模型注册中心 —— 让 travel-agent 兼容多个大模型（国内 + 国际），可插拔切换。
 *
 * 设计思路：
 * - pi 的 streamSimple 按 model.api 分发 provider；只要 api="openai-completions"，
 *   就会走官方 openai SDK，并使用 model.baseUrl 作为请求地址。
 * - 国内大模型（DeepSeek / 智谱 / Kimi / 通义 / 豆包）都提供 OpenAI 兼容接口，
 *   因此构造一个自定义 Model 对象、把 baseUrl 指向对应兼容端点即可直连，无需换框架。
 * - 每个模型条目绑定一个 apiKeyEnv（读取哪个环境变量作为密钥），未配置则视为不可用。
 * - 国际模型（OpenAI / Anthropic）走 pi 内置注册表 getModel。
 */
import { getModel } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";

/** 单个模型条目 */
export interface ModelEntry {
  /** 前端选择用的唯一 key */
  key: string;
  /** 展示名称 */
  label: string;
  /** 厂商分组（国内 / 国际） */
  group: "domestic" | "international";
  /** pi provider 名称（原生模型用 getModel；兼容模型统一用 openai） */
  provider: string;
  /** 模型 id（传给模型厂商的 model 字段） */
  modelId: string;
  /** OpenAI 兼容端点 baseUrl；原生模型留空 */
  baseUrl?: string;
  /** 从哪个环境变量读取 API Key */
  apiKeyEnv: string;
  /** 上下文窗口（仅用于展示 / 估算） */
  contextWindow: number;
  /** 备注（如豆包需要填接入点 id） */
  note?: string;
}

/**
 * 模型注册表。
 * 新增模型：在这里加一条即可，前端 /api/models 会自动列出。
 */
export const MODEL_REGISTRY: ModelEntry[] = [
  // —— 国内大模型（OpenAI 兼容） ——
  {
    key: "deepseek",
    label: "DeepSeek",
    group: "domestic",
    provider: "openai",
    modelId: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    contextWindow: 64_000,
  },
  {
    key: "deepseek-reasoner",
    label: "DeepSeek R1（推理）",
    group: "domestic",
    provider: "openai",
    modelId: "deepseek-reasoner",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    contextWindow: 64_000,
    note: "深度推理模型，适合复杂行程权衡",
  },
  {
    key: "zhipu",
    label: "智谱 GLM-4",
    group: "domestic",
    provider: "openai",
    modelId: "glm-4",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyEnv: "ZHIPU_API_KEY",
    contextWindow: 128_000,
  },
  {
    key: "kimi",
    label: "Kimi（月之暗面）",
    group: "domestic",
    provider: "openai",
    modelId: "moonshot-v1-8k",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    contextWindow: 8_000,
  },
  {
    key: "qwen",
    label: "通义千问（阿里百炼）",
    group: "domestic",
    provider: "openai",
    modelId: "qwen-plus",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    contextWindow: 128_000,
  },
  {
    key: "doubao",
    label: "豆包（火山方舟）",
    group: "domestic",
    provider: "openai",
    modelId: "REPLACE_WITH_YOUR_ENDPOINT_ID",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnv: "ARK_API_KEY",
    contextWindow: 32_000,
    note: "豆包用「接入点 ID」作为 modelId，需在火山方舟控制台创建后替换",
  },
  {
    key: "ernie",
    label: "文心一言（百度千帆）",
    group: "domestic",
    provider: "openai",
    modelId: "ernie-4.5-turbo-128k",
    baseUrl: "https://qianfan.baidubce.com/v2",
    apiKeyEnv: "QIANFAN_API_KEY",
    contextWindow: 128_000,
    note: "百度千帆 v2 OpenAI 兼容端点，使用千帆 IAM API Key",
  },
  {
    key: "stepfun",
    label: "阶跃星辰 Step",
    group: "domestic",
    provider: "openai",
    modelId: "step-2-16k",
    baseUrl: "https://api.stepfun.com/v1",
    apiKeyEnv: "STEPFUN_API_KEY",
    contextWindow: 16_000,
    note: "阶跃星辰，长上下文与多模态能力强",
  },
  // —— 国际大模型（走 pi 内置注册表） ——
  {
    key: "openai",
    label: "OpenAI GPT",
    group: "international",
    provider: "openai",
    modelId: "gpt-4o-mini",
    apiKeyEnv: "OPENAI_API_KEY",
    contextWindow: 128_000,
  },
  {
    key: "anthropic",
    label: "Anthropic Claude",
    group: "international",
    provider: "anthropic",
    modelId: "claude-3-5-haiku-20241022",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    contextWindow: 200_000,
  },
];

/**
 * 该模型是否已配置有效 API Key。
 * 过滤掉「sk-xxxx」「your-key」这类占位符：真实密钥一般 ≥ 20 字符，
 * 避免占位符被误判为可用而触发 401/402 报错，影响演示。
 */
export function isModelConfigured(entry: ModelEntry): boolean {
  const key = process.env[entry.apiKeyEnv]?.trim();
  return !!key && key.length >= 20;
}

/** 按 key 查条目 */
export function getModelEntry(key: string): ModelEntry | undefined {
  return MODEL_REGISTRY.find((m) => m.key === key);
}

/** 未显式指定模型时，自动挑选第一个已配置 Key 的模型（按注册顺序，国内优先） */
export function pickDefaultModel(): ModelEntry | undefined {
  return MODEL_REGISTRY.find((m) => isModelConfigured(m));
}

/**
 * 把条目解析成 pi 的 Model 对象。
 * - 有 baseUrl → 构造自定义 OpenAI 兼容模型（国内模型走这里）
 * - 无 baseUrl → 用 pi 内置 getModel（国际原生模型）
 */
export function resolveModel(entry: ModelEntry): Model<any> {
  if (entry.baseUrl) {
    return {
      id: entry.modelId,
      name: entry.label,
      api: "openai-completions" as const,
      provider: entry.provider,
      baseUrl: entry.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: entry.contextWindow,
      maxTokens: 4096,
    } as Model<any>;
  }
  // 原生模型：从 pi 注册表取（provider/modelId 必须是 pi 已知的）
  return getModel(entry.provider as never, entry.modelId as never);
}

/** 前端用：返回带「是否已配置」标记的模型列表 */
export function listModelsForClient() {
  return MODEL_REGISTRY.map((m) => ({
    key: m.key,
    label: m.label,
    group: m.group,
    configured: isModelConfigured(m),
    note: m.note,
  }));
}
