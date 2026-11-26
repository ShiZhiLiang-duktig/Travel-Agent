/**
 * 改动提案（Proposal）：AI 优化 / 天气调整的结果先以提案形式展示，
 * 用户点「应用」后才真正写入状态；应用后仍可撤销。
 *
 * 设计要点：
 *   - 提案只描述「改了什么」，apply / undo 由产生方注入，避免组件层知道业务状态。
 *   - 提案不落库、不持久化：关闭页面即失效，避免过期数据覆盖新行程。
 */

/** 单条改动 */
export interface ProposalChange {
  kind: "replace" | "reorder";
  /** 影响的天数（1 起） */
  day: number;
  /** 原内容 */
  from: string;
  /** 新内容 */
  to: string;
  /** 为什么改 */
  reason: string;
}

export interface Proposal {
  id: string;
  source: "weather" | "ai";
  title: string;
  summary: string;
  changes: ProposalChange[];
  /** 应用改动（由产生方写入对应状态） */
  apply: () => void;
  /** 撤销（应用后恢复快照） */
  undo?: () => void;
}

/** 生成本地唯一提案 id（仅用于 React key / 去重，不做持久化） */
export function newProposalId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
