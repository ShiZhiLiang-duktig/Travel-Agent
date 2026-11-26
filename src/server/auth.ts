/**
 * 鉴权模块 —— 登录 / 注册 / 会话 / 角色守卫。
 *
 * 设计要点（经验沉淀）：
 *   - 后端做最终权限裁决，前端仅作展示层；管理能力必须校验 role。
 *   - 会话用内存 Map（token → 用户），不依赖 DB，PG 挂了登录仍可用。
 *   - 用户存储：PG 就绪时走 users 表，失败降级到内存 Map（始终 seeded 默认账号）。
 *   - 密码用 node:crypto scrypt 哈希 + 随机盐，不存明文。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, MiddlewareHandler } from "hono";
import {
  isDbReady,
  dbListUsers,
  dbGetUserByUsername,
  dbCreateUser,
  dbDeleteUser,
  dbGetUserProfile,
  dbUpdateUserProfile,
} from "./db.js";

export type Role = "user" | "admin";

export interface AuthUser {
  id: number;
  username: string;
  role: Role;
}

/** 个人信息（昵称 / 所属城市 / 简介） */
export interface UserProfile extends AuthUser {
  created_at: string;
  nickname: string;
  city: string;
  bio: string;
}

interface Session {
  user: AuthUser;
  expires: number;
}

interface MemoryUser {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  created_at: Date;
  nickname?: string;
  city?: string;
  bio?: string;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

const sessions = new Map<string, Session>();
const memoryUsers = new Map<string, MemoryUser>();
let memNextId = 1;

// ──────────────── 密码哈希（scrypt） ────────────────
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 })
    .toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  try {
    const [alg, salt, hash] = stored.split("$");
    if (alg !== "scrypt" || !salt || !hash) return false;
    const candidate = crypto
      .scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 })
      .toString("hex");
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(candidate, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ──────────────── 默认账号种子 ────────────────
const DEFAULT_ACCOUNTS: { username: string; password: string; role: Role }[] = [
  { username: "admin", password: "admin123", role: "admin" },
  { username: "user", password: "user123", role: "user" },
];

/** 把默认账号写入内存（幂等，模块加载即执行，保证无 DB 也能登录） */
function seedMemoryDefaults(): void {
  for (const acc of DEFAULT_ACCOUNTS) {
    if (!memoryUsers.has(acc.username)) {
      memoryUsers.set(acc.username, {
        id: memNextId++,
        username: acc.username,
        password_hash: hashPassword(acc.password),
        role: acc.role,
        created_at: new Date(),
      });
    }
  }
}
// ──────────────── 本地持久化（无 PG 时兜底，node:fs 原子写，不依赖任何三方包） ────────────────
// 数据文件放项目根 .data/auth-store.json；PG 就绪时以 PG 为准，仅内存模式读写此文件。
const STORE_FILE = fileURLToPath(new URL("../../.data/auth-store.json", import.meta.url));

interface StoredUser {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  created_at: string;
  nickname: string;
  city: string;
  bio: string;
}
interface StoredStore {
  version: number;
  nextId: number;
  users: StoredUser[];
}

/** 从本地文件恢复内存用户（含个人信息）；损坏 / 不存在则忽略 */
function loadLocalStore(): void {
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) as StoredStore;
    if (!Array.isArray(data.users)) return;
    for (const u of data.users) {
      if (!u?.username || !u?.password_hash) continue;
      const id = Number(u.id) || 0;
      memoryUsers.set(u.username, {
        id,
        username: u.username,
        password_hash: u.password_hash,
        role: u.role === "admin" ? "admin" : "user",
        created_at: u.created_at ? new Date(u.created_at) : new Date(),
        nickname: u.nickname || "",
        city: u.city || "",
        bio: u.bio || "",
      });
      memNextId = Math.max(memNextId, id);
    }
  } catch (e) {
    console.warn("[auth] 本地用户存储读取失败（已忽略）:", (e as Error).message);
  }
}

/** 把内存用户原子写入本地文件；仅内存模式（无 PG）需要 */
function persistLocalStore(): void {
  if (isDbReady()) return;
  try {
    const payload: StoredStore = {
      version: 1,
      nextId: memNextId,
      users: [...memoryUsers.values()].map((u) => ({
        id: u.id,
        username: u.username,
        password_hash: u.password_hash,
        role: u.role,
        created_at: u.created_at.toISOString(),
        nickname: u.nickname || "",
        city: u.city || "",
        bio: u.bio || "",
      })),
    };
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    const tmp = STORE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmp, STORE_FILE);
  } catch (e) {
    console.warn("[auth] 本地用户存储写入失败:", (e as Error).message);
  }
}

// 先建默认账号，再用本地文件恢复（文件里的同名账号含用户改过的个人信息，覆盖默认值）
seedMemoryDefaults();
loadLocalStore();

/** 启动时调用：若 PG 就绪，把默认账号也写入 users 表（幂等） */
export async function initAuth(): Promise<void> {
  if (!isDbReady()) {
    console.log("[auth] PG 未就绪，使用内存用户存储（已含默认账号 admin/user）");
    return;
  }
  for (const acc of DEFAULT_ACCOUNTS) {
    try {
      await dbCreateUser(acc.username, hashPassword(acc.password), acc.role);
    } catch {
      /* 已存在或写入失败，忽略 */
    }
  }
  console.log("[auth] 鉴权就绪（PG 模式）：默认账号 admin / user");
}

// ──────────────── 存储读写（PG 优先，失败降级内存） ────────────────
async function findUser(username: string): Promise<MemoryUser | null> {
  // PG 优先
  try {
    const row = await dbGetUserByUsername(username);
    if (row) {
      const u = {
        id: Number(row.id),
        username: row.username,
        password_hash: row.password_hash,
        role: (row.role as Role) || "user",
        created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      };
      // 读穿缓存：保留已有的个人信息字段，避免 PG 返回的精简行覆盖本地资料
      const cached = memoryUsers.get(u.username);
      const merged: MemoryUser = {
        ...u,
        nickname: cached?.nickname ?? "",
        city: cached?.city ?? "",
        bio: cached?.bio ?? "",
      };
      memoryUsers.set(u.username, merged);
      return merged;
    }
  } catch {
    /* 降级内存 */
  }
  return memoryUsers.get(username) ?? null;
}

async function createUserInStore(username: string, password: string, role: Role): Promise<MemoryUser> {
  // 先写 PG（成功即以 PG 为准），再写内存（作为缓存/降级备份）
  const hash = hashPassword(password);
  try {
    const row = await dbCreateUser(username, hash, role);
    const u: MemoryUser = {
      id: Number(row.id),
      username: row.username,
      password_hash: row.password_hash,
      role: (row.role as Role) || "user",
      created_at: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    };
    memoryUsers.set(u.username, u);
    return u;
  } catch {
    /* PG 失败 → 仅内存 */
  }
  if (memoryUsers.has(username)) throw new Error("用户名已存在");
  const u: MemoryUser = {
    id: memNextId++,
    username,
    password_hash: hash,
    role,
    created_at: new Date(),
  };
  memoryUsers.set(username, u);
  persistLocalStore();
  return u;
}

function toPublic(u: MemoryUser): AuthUser & { created_at: string } {
  return { id: u.id, username: u.username, role: u.role, created_at: u.created_at.toISOString() };
}

function toProfile(u: MemoryUser): UserProfile {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    created_at: u.created_at.toISOString(),
    nickname: u.nickname || "",
    city: u.city || "",
    bio: u.bio || "",
  };
}

/** 读取个人信息（PG 优先，未就绪时读内存） */
export async function getProfile(userId: number): Promise<UserProfile | null> {
  try {
    const row = await dbGetUserProfile(userId);
    if (row) {
      return {
        id: Number(row.id),
        username: row.username,
        role: (row.role as Role) || "user",
        created_at: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
        nickname: row.nickname || "",
        city: row.city || "",
        bio: row.bio || "",
      };
    }
  } catch {
    /* 降级内存 */
  }
  const mu = [...memoryUsers.values()].find((u) => u.id === userId);
  return mu ? toProfile(mu) : null;
}

/** 更新个人信息：昵称 / 所属城市 / 简介（长度做基本约束） */
export async function updateProfile(
  userId: number,
  patch: { nickname?: string; city?: string; bio?: string },
): Promise<UserProfile> {
  const clean = {
    nickname: String(patch.nickname ?? "").trim().slice(0, 30),
    city: String(patch.city ?? "").trim().slice(0, 20),
    bio: String(patch.bio ?? "").trim().slice(0, 200),
  };
  try {
    const row = await dbUpdateUserProfile(userId, clean);
    if (row) {
      return {
        id: Number(row.id),
        username: row.username,
        role: (row.role as Role) || "user",
        created_at: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
        nickname: row.nickname || "",
        city: row.city || "",
        bio: row.bio || "",
      };
    }
  } catch {
    /* 降级内存 */
  }
  const mu = [...memoryUsers.values()].find((u) => u.id === userId);
  if (!mu) throw new Error("用户不存在");
  mu.nickname = clean.nickname;
  mu.city = clean.city;
  mu.bio = clean.bio;
  persistLocalStore();
  return toProfile(mu);
}

// ──────────────── 会话 ────────────────
function issueToken(user: AuthUser): string {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { user, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

export function verifyToken(token: string | undefined | null): AuthUser | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s.user;
}

export function destroySession(token: string | undefined | null): void {
  if (token) sessions.delete(token);
}

// ──────────────── 业务接口 ────────────────
export async function login(username: string, password: string): Promise<{ token: string; user: AuthUser } | null> {
  const u = await findUser(username);
  if (!u || !verifyPassword(password, u.password_hash)) return null;
  const user: AuthUser = { id: u.id, username: u.username, role: u.role };
  return { token: issueToken(user), user };
}

export async function register(username: string, password: string): Promise<AuthUser> {
  const name = (username || "").trim();
  if (name.length < 2) throw new Error("用户名至少 2 个字符");
  if (password.length < 6) throw new Error("密码至少 6 个字符");
  // 注册只能创建普通用户
  const existing = await findUser(name);
  if (existing) throw new Error("用户名已存在");
  const u = await createUserInStore(name, password, "user");
  return { id: u.id, username: u.username, role: u.role };
}

export async function listAllUsers(): Promise<(AuthUser & { created_at: string })[]> {
  try {
    const rows = await dbListUsers();
    return rows.map((r) => ({
      id: Number(r.id),
      username: r.username,
      role: (r.role as Role) || "user",
      created_at: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
    }));
  } catch {
    return [...memoryUsers.values()].map(toPublic);
  }
}

export async function deleteUserById(id: number, actorId: number): Promise<boolean> {
  if (id === actorId) throw new Error("不能删除自己");
  try {
    const ok = await dbDeleteUser(id);
    // 同步从内存移除（按 id）
    for (const [k, v] of memoryUsers) if (v.id === id) memoryUsers.delete(k);
    persistLocalStore();
    return ok;
  } catch {
    let found = false;
    for (const [k, v] of memoryUsers) {
      if (v.id === id) {
        memoryUsers.delete(k);
        found = true;
      }
    }
    if (found) persistLocalStore();
    return found;
  }
}

// ──────────────── Hono 中间件 ────────────────
function bearerToken(c: Context): string | null {
  const h = c.req.header("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

/** 登录校验：任何已登录用户可通过 */
export function requireAuth(): MiddlewareHandler {
  return async (c, next) => {
    const user = verifyToken(bearerToken(c));
    if (!user) return c.json({ error: "未登录或登录已过期" }, 401);
    c.set("user", user);
    await next();
  };
}

/** 管理员校验：仅 admin 可通过 */
export function requireAdmin(): MiddlewareHandler {
  return async (c, next) => {
    const user = verifyToken(bearerToken(c));
    if (!user) return c.json({ error: "未登录或登录已过期" }, 401);
    if (user.role !== "admin") return c.json({ error: "需要管理员权限" }, 403);
    c.set("user", user);
    await next();
  };
}

/** 从上下文取当前登录用户 */
export function currentUser(c: Context): AuthUser | undefined {
  return c.get("user") as AuthUser | undefined;
}
