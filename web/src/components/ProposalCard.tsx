/**
 * 改动确认卡片：天气调整 / AI 优化的结果先在这里预览，用户确认后才生效。
 * 应用后仍可「撤销」，恢复应用前的快照。
 */
import { useState } from "react";
import type { Proposal } from "../proposal";

const SOURCE_LABEL: Record<Proposal["source"], string> = {
  weather: "🌧 天气调整",
  ai: "🤖 AI 建议",
};

export default function ProposalCard({
  proposal,
  onDismiss,
}: {
  proposal: Proposal;
  onDismiss: () => void;
}) {
  const [applied, setApplied] = useState(false);

  return (
    <section className={`proposal-card glass fade-up proposal-${proposal.source}`}>
      <div className="proposal-head">
        <span className="proposal-badge">{SOURCE_LABEL[proposal.source]}</span>
        <h3>{proposal.title}</h3>
        <span className="pill amber">{proposal.changes.length} 处改动</span>
      </div>
      <p className="proposal-summary">{proposal.summary}</p>
      <ul className="proposal-list">
        {proposal.changes.map((c, i) => (
          <li key={`${c.day}-${c.from}-${i}`}>
            <span className="proposal-day">D{c.day}</span>
            <span className="proposal-from">{c.from}</span>
            <span className="proposal-arrow">→</span>
            <span className="proposal-to">{c.to}</span>
            <span className="proposal-reason">{c.reason}</span>
          </li>
        ))}
      </ul>
      <div className="proposal-actions">
        {!applied ? (
          <>
            <button
              type="button"
              className="btn-run"
              onClick={() => {
                proposal.apply();
                setApplied(true);
              }}
            >
              应用改动
            </button>
            <button type="button" className="btn-ghost" onClick={onDismiss}>
              放弃
            </button>
          </>
        ) : (
          <>
            <span className="proposal-applied">✓ 已应用</span>
            {proposal.undo && (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  proposal.undo?.();
                  onDismiss();
                }}
              >
                撤销
              </button>
            )}
            <button type="button" className="btn-ghost" onClick={onDismiss}>
              关闭
            </button>
          </>
        )}
      </div>
    </section>
  );
}
