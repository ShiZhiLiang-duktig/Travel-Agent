/**
 * 文本向量化（Embedding）—— 为 PgVector 语义检索提供向量。
 *
 * 两种提供方（通过 EMBEDDING_PROVIDER 环境变量切换）：
 *   - local（默认）：本地确定性哈希 embedding，零依赖零 Key、离线可用，
 *     基于中文单字 + 二元组哈希到 512 维并 L2 归一化，短文本检索效果够用。
 *   - zhipu：调用智谱 embedding-3（国内合规、OpenAI 风格），产出真实语义向量。
 *
 * 统一输出 512 维，与 db.ts 中 vector(512) 列保持一致。
 */
export const EMBED_DIM = 512;

export type EmbeddingProvider = "local" | "zhipu";

/** 当前生效的 embedding 提供方（未显式配置或缺少 Key 时回退 local） */
export function embeddingProvider(): EmbeddingProvider {
  const p = (process.env.EMBEDDING_PROVIDER || "local").toLowerCase();
  if (p === "zhipu" && process.env.ZHIPU_API_KEY) return "zhipu";
  return "local";
}

/** 向量化单条文本 */
export async function embed(text: string): Promise<number[]> {
  if (embeddingProvider() === "zhipu") {
    try {
      return await embedWithZhipu(text);
    } catch (err: any) {
      console.warn(`[embedding] 智谱 embedding 失败，回退本地哈希：${err?.message}`);
    }
  }
  return localEmbed(text);
}

/** 批量向量化（顺序执行，避免触发限流） */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (const t of texts) out.push(await embed(t));
  return out;
}

/** pgvector 字面量：[0.1,0.2,...] */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

// ---------- 智谱 embedding-3 ----------
async function embedWithZhipu(text: string): Promise<number[]> {
  const key = process.env.ZHIPU_API_KEY!;
  const res = await fetch("https://open.bigmodel.cn/api/paas/v4/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "embedding-3",
      input: text,
      dimensions: EMBED_DIM,
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as { data?: { embedding: number[] }[] };
  const vec = data.data?.[0]?.embedding;
  if (!vec || vec.length !== EMBED_DIM) {
    throw new Error(`返回向量维度异常（期望 ${EMBED_DIM}，实际 ${vec?.length ?? 0}）`);
  }
  return normalize(vec);
}

// ---------- 本地确定性哈希 embedding ----------
/** FNV-1a 32 位哈希 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 清洗：去标点空白、转小写 */
function clean(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * 本地 embedding：中文单字 + 二元组 → 哈希桶累加 → L2 归一化。
 * 相同文本必得相同向量（确定性），语义相近的短文本会有较高余弦相似度。
 */
function localEmbed(text: string): number[] {
  const vec = new Array<number>(EMBED_DIM).fill(0);
  const s = clean(text);
  if (!s) return vec;

  const add = (token: string) => {
    const h = fnv1a(token);
    const bucket = h % EMBED_DIM;
    const sign = (h >>> 16) & 1 ? -1 : 1;
    vec[bucket] += sign;
  };

  // 单字
  for (const ch of s) add(ch);
  // 二元组（捕捉「博物馆」「无障碍」这类词）
  for (let i = 0; i < s.length - 1; i++) add(s.slice(i, i + 2));

  return normalize(vec);
}

/** L2 归一化（零向量原样返回） */
function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}
