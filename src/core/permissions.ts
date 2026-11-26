/**
 * 权限钩子（before_tool_call）—— "受控 Agent"的落地点。
 *
 * 借鉴 pi/harness 的思想：工具执行前统一拦截，按动作分级决定放行/审批/拒绝。
 * - read（只读）：自动放行
 * - reversible_write（可逆写入）：放行但记录
 * - external_action（外部动作：下单/付款/发消息）：必须人工确认
 *
 * Python 版 src/core/permissions.py 的 TS 重写。
 */

export const ActionLevel = {
  READ: "read",
  REVERSIBLE_WRITE: "reversible_write",
  EXTERNAL_ACTION: "external_action",
} as const;
export type ActionLevel = (typeof ActionLevel)[keyof typeof ActionLevel];

/** 工具名到动作级别的映射（白名单）。 */
export const TOOL_POLICY: Record<string, ActionLevel> = {
  search_poi: ActionLevel.READ,
  get_weather: ActionLevel.READ,
  query_price: ActionLevel.READ,
  save_itinerary: ActionLevel.REVERSIBLE_WRITE,
  book_ticket: ActionLevel.EXTERNAL_ACTION,
  send_message: ActionLevel.EXTERNAL_ACTION,
};

export class PermissionDenied extends Error {}

export interface PermissionDecision {
  allowed: boolean;
  level: ActionLevel;
  need_approval: boolean;
  logged?: boolean;
  approved?: boolean;
}

/** approver: 人工审批回调，返回 true 表示批准。 */
export type Approver = (tool_name: string) => boolean;

/**
 * 工具调用前的统一拦截钩子。
 * 外部动作未获批准则抛 PermissionDenied。
 */
export function before_tool_call(
  tool_name: string,
  level?: ActionLevel,
  approver?: Approver
): PermissionDecision {
  const resolvedLevel = level ?? TOOL_POLICY[tool_name] ?? ActionLevel.EXTERNAL_ACTION;

  if (resolvedLevel === ActionLevel.READ) {
    return { allowed: true, level: resolvedLevel, need_approval: false };
  }
  if (resolvedLevel === ActionLevel.REVERSIBLE_WRITE) {
    return { allowed: true, level: resolvedLevel, need_approval: false, logged: true };
  }
  if (resolvedLevel === ActionLevel.EXTERNAL_ACTION) {
    const approved = approver ? approver(tool_name) : false;
    if (!approved) {
      throw new PermissionDenied(`外部动作 ${tool_name} 未获人工批准，已拒绝执行`);
    }
    return { allowed: true, level: resolvedLevel, need_approval: true, approved: true };
  }

  throw new PermissionDenied(`未知动作级别: ${resolvedLevel}`);
}
