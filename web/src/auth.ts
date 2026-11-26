/**
 * 前端鉴权：token 存取 + 登录/注册/当前用户/登出 + 鉴权头注入。
 * token 存 localStorage，刷新后通过 /api/auth/me 校验有效性（失效则清除）。
 */
const BASE = (import.meta as any).env?.VITE_API_BASE || "";

const TOKEN_KEY = "tw_token";
const USER_KEY = "tw_user";

export type Role = "user" | "admin";

export interface AuthUser {
  id: number;
  username: string;
  role: Role;
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: AuthUser): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* 隐私模式等忽略 */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}

/** 为 fetch 注入 Authorization 头（无 token 时返回空对象） */
export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** 统一请求：带鉴权头，401 时自动清除会话 */
async function authFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers = { ...(init?.headers || {}), ...authHeaders() };
  const resp = await fetch(input, { ...init, headers });
  if (resp.status === 401) clearSession();
  return resp;
}

export async function login(
  username: string,
  password: string,
): Promise<{ token: string; user: AuthUser }> {
  const resp = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `登录失败（${resp.status}）`);
  return { token: j.token, user: j.user };
}

export async function register(username: string, password: string): Promise<AuthUser> {
  const resp = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(j.error || `注册失败（${resp.status}）`);
  return j.user;
}

/** 校验本地 token 是否仍有效（后端 session 存在）；失效返回 null 并清除 */
export async function fetchMe(): Promise<AuthUser | null> {
  if (!getToken()) return null;
  try {
    const resp = await authFetch(`${BASE}/api/auth/me`);
    if (!resp.ok) return null;
    const j = await resp.json().catch(() => ({}));
    if (j?.user) setSession(getToken()!, j.user); // 刷新缓存的用户信息
    return j?.user ?? null;
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await authFetch(`${BASE}/api/auth/logout`, { method: "POST" });
  } catch {
    /* 忽略网络错误，本地仍清除 */
  }
  clearSession();
}
