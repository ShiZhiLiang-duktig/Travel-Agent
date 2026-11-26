/**
 * 本地轻量持久化：视图 / 城市 / 日期 / 手动选点 / POI 收藏。
 *
 * 设计要点：
 *   - 旅行偏好（预算 / 节奏 / 人群 / 必去 / 避开 / 两个开关 / 补充描述）**刻意不落盘**：
 *     每次刷新页面都从默认值开始，避免上一次的选择继续生效、干扰新的行程。
 *     旧版本草稿里残留的 prefs / extra 会在读取时顺手清除（迁移）。
 *   - 只存用户自己的输入，不存 Agent 运行结果（结果仍以一次运行为准，避免脏数据回放）。
 *   - 写入统一走 writeJson；隐私模式 / 配额不足时静默降级为内存态。
 *   - clearSession 供「清空」按钮同步删除草稿。
 */
import type { ManualStop } from "./api";

const SESSION_KEY = "tw_session_v1";
const FAV_KEY = "tw_favorite_pois_v1";

export interface SavedSession {
  view: "ai" | "manual";
  cities: string[];
  startDate: string;
  endDate: string;
  manualStops: ManualStop[];
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式 / 配额不足时静默降级为内存态 */
  }
}

/** 只保留字符串数组，避免脏数据掺进 UI 造成 includes / map 崩溃 */
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function loadSession(): SavedSession | null {
  const raw = readJson<Record<string, unknown>>(SESSION_KEY);
  if (!raw || typeof raw !== "object") return null;

  const session: SavedSession = {
    view: raw.view === "manual" ? "manual" : "ai",
    cities: strArray(raw.cities),
    startDate: typeof raw.startDate === "string" ? raw.startDate : "",
    endDate: typeof raw.endDate === "string" ? raw.endDate : "",
    manualStops: Array.isArray(raw.manualStops) ? (raw.manualStops as ManualStop[]) : [],
  };

  // 迁移：旧版本把偏好一起存了，就地重写一遍把 prefs / extra 抹掉，
  // 否则历史选择会一直留在 localStorage 里（虽然不再被读取，也没必要留着）。
  if ("prefs" in raw || "extra" in raw) writeJson(SESSION_KEY, session);

  return session;
}

export function saveSession(s: SavedSession): void {
  writeJson(SESSION_KEY, s);
}

/** 「清空」：连本地草稿一起删除，刷新后不会恢复旧选择 */
export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* 忽略：隐私模式下本来也读不到 */
  }
}

/** POI 收藏：按 id 保存，跨行程复用（参考 TREK Collections 的轻量化版本） */
export function loadFavorites(): string[] {
  return strArray(readJson<unknown>(FAV_KEY));
}

export function saveFavorites(ids: string[]): void {
  writeJson(FAV_KEY, ids);
}
