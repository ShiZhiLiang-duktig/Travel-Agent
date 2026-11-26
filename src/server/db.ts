/**
 * PostgreSQL + PgVector 数据层。
 *
 * 职责：
 *   1. 连接池管理（PG 不可用时优雅降级，服务照常启动）
 *   2. 建表：pois（含 vector(512) 语义向量 + HNSW 索引）、runs（运行记录）
 *   3. 首次启动从本地快照导入 POI 并计算 embedding（幂等）
 *   4. 语义检索：给定自然语言查询，按余弦相似度召回 POI
 *   5. 运行记录落库（供 Trace 回放 / 历史指标）
 *
 * 环境变量：
 *   DATABASE_URL  默认 postgres://travel:travel@localhost:5432/travel
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { load_pois, list_cities } from "../data/snapshot.js";
import { embed, toVectorLiteral, EMBED_DIM, embeddingProvider } from "./embeddings.js";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://travel:travel@localhost:5432/travel";

/** 用于建表的 seed 结构（与本地快照 POI 字段对齐） */
interface SeedPoi {
  id: string;
  name: string;
  city: string;
  category: string;
  indoor?: string;
  price_per_person?: number;
  stairs?: number;
  visit_minutes?: number;
  needs_reservation?: boolean;
  mobility_note?: string;
  lat?: number;
  lng?: number;
}

let pool: Pool | null = null;
let ready = false;
let lastError: string | null = null;

/**
 * 本地文件向量后端：PG 不可用时启用，基于内置快照 POI + 本地 embedding 做余弦相似度检索，
 * 运行记录写本地 JSON 文件。零外部依赖（embedding 本身已是纯 JS），保证无 Docker 也能用。
 * 注意：isDbReady() 仍严格表示「PG 就绪」，供 auth/shares 判断；不要修改其语义。
 */
const LOCAL_DB_FILE = fileURLToPath(new URL("../../.data/local-db.json", import.meta.url));
let localReady = false;
interface LocalPoi {
  poi: Omit<PoiSearchHit, "score">;
  vec: number[];
}
const localPois: LocalPoi[] = [];
const localRuns: Record<string, unknown>[] = [];

/** 语义检索是否可用（PG 或本地文件后端） */
export function isSemanticReady(): boolean {
  return ready || localReady;
}

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10_000,
    });
    pool.on("error", (err) => {
      console.warn("[db] 连接池错误：", err.message);
    });
  }
  return pool;
}

/** PG 是否已就绪（建表 + 种子完成） */
export function isDbReady(): boolean {
  return ready;
}

export function getDbStatus() {
  return {
    ready,
    /** 语义检索 / 运行记录是否可用：PG 就绪或本地文件后端已启用 */
    semanticReady: ready || localReady,
    /** 实际生效的存储：postgres / local-file */
    store: ready ? "postgres" : localReady ? "local-file" : "none",
    provider: embeddingProvider(),
    dim: EMBED_DIM,
    error: lastError,
  };
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pois (
  id text PRIMARY KEY,
  city text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  indoor text,
  price_per_person integer NOT NULL DEFAULT 0,
  stairs integer NOT NULL DEFAULT 0,
  visit_minutes integer NOT NULL DEFAULT 0,
  needs_reservation boolean NOT NULL DEFAULT false,
  mobility_note text,
  lat double precision,
  lng double precision,
  content text NOT NULL,
  embedding vector(${EMBED_DIM}) NOT NULL
);
CREATE INDEX IF NOT EXISTS pois_embedding_hnsw ON pois USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS pois_city_idx ON pois (city);

CREATE TABLE IF NOT EXISTS runs (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  city text,
  days integer,
  mode text,
  model text,
  total_cost integer,
  item_count integer,
  constraint_pass_rate real,
  hallucination_rate real,
  resilience_score real,
  events jsonb
);
CREATE INDEX IF NOT EXISTS runs_created_idx ON runs (created_at DESC);

CREATE TABLE IF NOT EXISTS users (
  id bigserial PRIMARY KEY,
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_username_idx ON users (username);
-- 个人信息字段（老库自动补齐，幂等）
ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text;

CREATE TABLE IF NOT EXISTS shares (
  slug text PRIMARY KEY,
  owner text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shares_created_idx ON shares (created_at DESC);
`;

/**
 * 初始化数据库：建扩展 → 建表 → 首次导入种子 POI。
 * 任何失败都会记录并降级（ready=false），不阻塞服务启动。
 */
export async function initDb(): Promise<void> {
  const p = getPool();
  try {
    await p.query("select 1");
    await p.query("create extension if not exists vector");
    await p.query(SCHEMA_SQL);

    const { rows } = await p.query<{ c: number }>("select count(*)::int as c from pois");
    if (rows[0].c === 0) {
      const count = await seedPois(p);
      console.log(`[db] 已导入 ${count} 条 POI（embedding=${embeddingProvider()}）`);
    } else {
      console.log(`[db] 已有 ${rows[0].c} 条 POI，跳过导入`);
    }
    ready = true;
    lastError = null;
    console.log(`[db] PgVector 就绪：${maskUrl(DATABASE_URL)}`);
  } catch (err: any) {
    ready = false;
    lastError = friendlyDbError(err);
    // PG 不可用 → 启用本地文件向量后端，语义检索与运行记录照常可用（无需 Docker）
    await initLocalStore();
    if (localReady) {
      console.warn(
        `[db] PostgreSQL 未连接，已启用本地文件后端（语义检索 / 运行记录可用）：${lastError}\n` +
          `     如需 PgVector 全量能力，启动 PostgreSQL 后重启即可自动切换 —— docker compose up -d`,
      );
    } else {
      console.warn(
        `[db] 初始化失败，语义检索与运行记录将不可用（服务仍可启动）：${lastError}`,
      );
    }
  }
}

/** 初始化本地文件后端：已有文件直接读；否则从内置快照生成 embedding 并落盘 */
async function initLocalStore(): Promise<void> {
  try {
    // 1. 运行记录：追加模式，历史不丢
    if (fs.existsSync(LOCAL_DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(LOCAL_DB_FILE, "utf8"));
      if (Array.isArray(data?.runs)) localRuns.push(...data.runs);
      // 2. POI 向量缓存：命中则复用，避免每次启动重算
      if (Array.isArray(data?.pois) && data.pois.length) {
        for (const item of data.pois) {
          if (Array.isArray(item?.vec) && item?.poi?.id) localPois.push(item);
        }
      }
    }
    // 3. 没有向量缓存 → 从内置快照生成
    if (!localPois.length) {
      const all: SeedPoi[] = [];
      for (const city of list_cities()) all.push(...(load_pois(city) as unknown as SeedPoi[]));
      for (const poi of all) {
        const content = buildContent(poi);
        const vec = await embed(content);
        localPois.push({
          poi: {
            id: poi.id,
            city: poi.city,
            name: poi.name,
            category: poi.category,
            indoor: poi.indoor ?? null,
            price_per_person: poi.price_per_person ?? 0,
            stairs: poi.stairs ?? 0,
            visit_minutes: poi.visit_minutes ?? 0,
            needs_reservation: poi.needs_reservation ?? false,
            mobility_note: poi.mobility_note ?? null,
          },
          vec,
        });
      }
      persistLocalDb();
    }
    localReady = localPois.length > 0;
    if (localReady) console.log(`[db] 本地文件后端就绪：${localPois.length} 条 POI 向量（无需 PG）`);
  } catch (e: any) {
    console.warn(`[db] 本地文件后端初始化失败：${e?.message || e}`);
    localReady = false;
  }
}

/** 原子写入本地数据库文件（POI 向量缓存 + 运行记录） */
function persistLocalDb(): void {
  try {
    fs.mkdirSync(path.dirname(LOCAL_DB_FILE), { recursive: true });
    const payload = { version: 1, pois: localPois, runs: localRuns.slice(-500) };
    const tmp = LOCAL_DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
    fs.renameSync(tmp, LOCAL_DB_FILE);
  } catch (e: any) {
    console.warn(`[db] 本地数据库写入失败：${e?.message || e}`);
  }
}

/** 余弦相似度（向量已归一化，点积即相似度），与 pgvector 的 1 - (a <=> b) 等价 */
function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 把底层连接错误转成可读提示 */
function friendlyDbError(err: any): string {
  const code = err?.code || err?.errors?.[0]?.code;
  if (code === "ECONNREFUSED") {
    return `无法连接 PostgreSQL（${maskUrl(DATABASE_URL)}）：连接被拒绝，请确认数据库已启动`;
  }
  if (code === "ENOTFOUND") {
    return `无法解析数据库主机：${maskUrl(DATABASE_URL)}`;
  }
  if (err?.name === "AggregateError") {
    return `无法连接 PostgreSQL（${maskUrl(DATABASE_URL)}）：请确认数据库已启动`;
  }
  return err?.message || String(err);
}

/** 从本地快照导入所有城市 POI（含 embedding） */
async function seedPois(p: Pool): Promise<number> {
  const all: SeedPoi[] = [];
  for (const city of list_cities()) all.push(...(load_pois(city) as unknown as SeedPoi[]));

  let n = 0;
  for (const poi of all) {
    const content = buildContent(poi);
    const vec = toVectorLiteral(await embed(content));
    await p.query(
      `INSERT INTO pois
        (id, city, name, category, indoor, price_per_person, stairs, visit_minutes,
         needs_reservation, mobility_note, lat, lng, content, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::vector)
       ON CONFLICT (id) DO NOTHING`,
      [
        poi.id,
        poi.city,
        poi.name,
        poi.category,
        poi.indoor ?? null,
        poi.price_per_person ?? 0,
        poi.stairs ?? 0,
        poi.visit_minutes ?? 0,
        poi.needs_reservation ?? false,
        poi.mobility_note ?? null,
        poi.lat ?? null,
        poi.lng ?? null,
        content,
        vec,
      ],
    );
    n++;
  }
  return n;
}

/** 拼装用于 embedding 的语义文本 */
function buildContent(poi: SeedPoi): string {
  return [
    poi.name,
    poi.category,
    poi.indoor ? `室内外:${poi.indoor}` : "",
    poi.needs_reservation ? "需提前预约" : "",
    poi.mobility_note ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** 语义检索命中项（用 type 而非 interface：便于满足 pg 的 QueryResultRow 约束） */
export type PoiSearchHit = {
  id: string;
  city: string;
  name: string;
  category: string;
  indoor: string | null;
  price_per_person: number;
  stairs: number;
  visit_minutes: number;
  needs_reservation: boolean;
  mobility_note: string | null;
  score: number;
};

/**
 * 语义检索：按自然语言查询召回最相关 POI。
 * @param query 自然语言，如「适合老人的室内景点」「雨天不淋雨的地方」
 * @param city  可选城市过滤
 * @param limit 返回条数
 */
export async function searchPois(
  query: string,
  city?: string | null,
  limit = 8,
): Promise<PoiSearchHit[]> {
  // 本地文件后端：JS 余弦相似度排序，行为与 pgvector 一致
  if (!ready && localReady) {
    const qv = await embed(query);
    return localPois
      .filter((it) => !city || it.poi.city === city)
      .map((it) => ({ ...it.poi, score: cosineSimilarity(qv, it.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(50, Math.max(1, limit)));
  }
  if (!ready) throw new Error("数据库未就绪，且本地文件后端不可用");
  const vec = toVectorLiteral(await embed(query));
  const { rows } = await getPool().query<PoiSearchHit>(
    `SELECT id, city, name, category, indoor, price_per_person, stairs, visit_minutes,
            needs_reservation, mobility_note,
            1 - (embedding <=> $1::vector) AS score
       FROM pois
      WHERE ($2::text IS NULL OR city = $2)
      ORDER BY embedding <=> $1::vector
      LIMIT $3`,
    [vec, city ?? null, Math.min(50, Math.max(1, limit))],
  );
  return rows.map((r) => ({ ...r, score: Number(r.score) }));
}

export interface RunRecord {
  city: string;
  days: number;
  mode: string;
  model?: string;
  total_cost?: number;
  item_count?: number;
  constraint_pass_rate?: number;
  hallucination_rate?: number;
  resilience_score?: number;
  events?: unknown;
}

/** 运行记录落库（失败静默，不影响主流程） */
export async function saveRun(rec: RunRecord): Promise<void> {
  // 本地文件后端：追加运行记录并落盘（只保留最近 500 条）
  if (!ready && localReady) {
    localRuns.push({
      id: localRuns.length ? Number(localRuns[localRuns.length - 1].id) + 1 : 1,
      created_at: new Date().toISOString(),
      ...rec,
      events: rec.events ? JSON.parse(JSON.stringify(rec.events)) : null,
    });
    if (localRuns.length > 500) localRuns.splice(0, localRuns.length - 500);
    persistLocalDb();
    return;
  }
  if (!ready) return;
  try {
    await getPool().query(
      `INSERT INTO runs
        (city, days, mode, model, total_cost, item_count,
         constraint_pass_rate, hallucination_rate, resilience_score, events)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        rec.city,
        rec.days,
        rec.mode,
        rec.model ?? null,
        rec.total_cost ?? null,
        rec.item_count ?? null,
        rec.constraint_pass_rate ?? null,
        rec.hallucination_rate ?? null,
        rec.resilience_score ?? null,
        rec.events ? JSON.stringify(rec.events) : null,
      ],
    );
  } catch (err: any) {
    console.warn("[db] 运行记录写入失败：", err?.message);
  }
}

/** 最近的运行记录（不含 events 大字段） */
export async function recentRuns(limit = 20) {
  if (!ready && localReady) {
    return [...localRuns]
      .reverse()
      .slice(0, Math.min(100, Math.max(1, limit)))
      .map(({ events: _events, ...rest }) => rest);
  }
  if (!ready) return [];
  const { rows } = await getPool().query(
    `SELECT id, created_at, city, days, mode, model, total_cost, item_count,
            constraint_pass_rate, hallucination_rate, resilience_score
       FROM runs ORDER BY created_at DESC LIMIT $1`,
    [Math.min(100, Math.max(1, limit))],
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────
// 用户账号（users 表）—— PG 就绪时使用；未就绪时由 auth.ts 内存降级
// ─────────────────────────────────────────────────────────────
export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  created_at: Date;
}

/** 列出所有用户（不含密码哈希在路由层剥离） */
export async function dbListUsers(): Promise<UserRow[]> {
  if (!ready) throw new Error("db not ready");
  const { rows } = await getPool().query<UserRow>(
    `SELECT id, username, password_hash, role, created_at FROM users ORDER BY id ASC`,
  );
  return rows;
}

export async function dbGetUserByUsername(username: string): Promise<UserRow | null> {
  if (!ready) throw new Error("db not ready");
  const { rows } = await getPool().query<UserRow>(
    `SELECT id, username, password_hash, role, created_at FROM users WHERE username = $1`,
    [username],
  );
  return rows[0] ?? null;
}

export async function dbCreateUser(
  username: string,
  passwordHash: string,
  role: string,
): Promise<UserRow> {
  if (!ready) throw new Error("db not ready");
  const { rows } = await getPool().query<UserRow>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3)
     ON CONFLICT (username) DO NOTHING
     RETURNING id, username, password_hash, role, created_at`,
    [username, passwordHash, role],
  );
  if (!rows[0]) {
    const existing = await dbGetUserByUsername(username);
    if (existing) return existing;
    throw new Error("创建用户失败");
  }
  return rows[0];
}

export async function dbDeleteUser(id: number): Promise<boolean> {
  if (!ready) throw new Error("db not ready");
  const { rowCount } = await getPool().query(`DELETE FROM users WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

/** 个人信息行（昵称 / 所属城市 / 简介） */
export interface UserProfileRow {
  id: number;
  username: string;
  role: string;
  nickname: string | null;
  city: string | null;
  bio: string | null;
  created_at: Date;
}

export async function dbGetUserProfile(id: number): Promise<UserProfileRow | null> {
  if (!ready) throw new Error("db not ready");
  const { rows } = await getPool().query<UserProfileRow>(
    `SELECT id, username, role, nickname, city, bio, created_at FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function dbUpdateUserProfile(
  id: number,
  p: { nickname: string; city: string; bio: string },
): Promise<UserProfileRow | null> {
  if (!ready) throw new Error("db not ready");
  const { rows } = await getPool().query<UserProfileRow>(
    `UPDATE users SET nickname = $2, city = $3, bio = $4 WHERE id = $1
     RETURNING id, username, role, nickname, city, bio, created_at`,
    [id, p.nickname || null, p.city || null, p.bio || null],
  );
  return rows[0] ?? null;
}

export async function dbCountUsers(): Promise<number> {
  if (!ready) return 0;
  const { rows } = await getPool().query<{ c: number }>(
    `SELECT count(*)::int AS c FROM users`,
  );
  return rows[0]?.c ?? 0;
}

// ─────────────────────────────────────────────────────────────
// 只读分享（shares 表）—— PG 就绪时使用；未就绪时由 shares.ts 内存降级
// ─────────────────────────────────────────────────────────────
export interface ShareRow {
  slug: string;
  owner: string | null;
  payload: unknown;
  created_at: Date;
}

export async function dbSaveShare(
  slug: string,
  payload: unknown,
  owner: string,
): Promise<void> {
  if (!ready) throw new Error("db not ready");
  await getPool().query(
    `INSERT INTO shares (slug, owner, payload) VALUES ($1,$2,$3::jsonb)`,
    [slug, owner, JSON.stringify(payload)],
  );
}

export async function dbGetShare(slug: string): Promise<ShareRow | null> {
  if (!ready) throw new Error("db not ready");
  const { rows } = await getPool().query<ShareRow>(
    `SELECT slug, owner, payload, created_at FROM shares WHERE slug = $1`,
    [slug],
  );
  return rows[0] ?? null;
}

/** 关闭连接池（测试/优雅退出用） */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
  ready = false;
}

/** 隐藏连接串里的密码 */
function maskUrl(url: string): string {
  return url.replace(/:\/\/([^:]+):[^@]*@/, "://$1:****@");
}
