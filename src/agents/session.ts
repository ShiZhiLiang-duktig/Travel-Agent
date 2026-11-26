/**
 * 旅行 Agent 的共享会话状态。
 *
 * pi 的工具是无状态函数，多轮工具调用之间（plan→validate→stress→replan）
 * 需要共享同一份行程 / POI / 约束。这里用一个进程内单例 store 桥接。
 * 注意：这是 demo 级实现，单进程单用户；生产环境应替换为带 sessionId 的存储。
 */
import type { Constraints, Itinerary, POI } from "../core/models.js";

export interface TravelSession {
  city: string;
  days: number;
  pois: POI[];
  constraints: Constraints;
  itinerary: Itinerary | null;
}

let current: TravelSession | null = null;

export function getSession(): TravelSession {
  if (!current) {
    throw new Error("尚未规划行程，请先调用 plan_trip 工具");
  }
  return current;
}

export function setSession(s: TravelSession): void {
  current = s;
}

export function clearSession(): void {
  current = null;
}

export function hasSession(): boolean {
  return current !== null;
}
