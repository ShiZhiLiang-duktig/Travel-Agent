/** 汇总指标卡 */
import type { MetricsView } from "../api";

export default function MetricsStrip({ metrics }: { metrics: MetricsView }) {
  const cards = [
    {
      label: "约束满足率",
      value: `${Math.round(metrics.constraint_pass_rate * 100)}%`,
      percent: Math.round(metrics.constraint_pass_rate * 100),
      color: "linear-gradient(135deg,#10b981,#059669)",
    },
    {
      label: "幻觉率",
      value: `${Math.round(metrics.hallucination_rate * 100)}%`,
      percent: Math.round(metrics.hallucination_rate * 100),
      color:
        metrics.hallucination_rate > 0
          ? "linear-gradient(135deg,#ef4444,#dc2626)"
          : "linear-gradient(135deg,#10b981,#059669)",
    },
    {
      label: "韧性分",
      value: `${Math.round(metrics.resilience_score * 100)}%`,
      percent: Math.round(metrics.resilience_score * 100),
      color: "linear-gradient(135deg,#4f46e5,#06b6d4)",
    },
    {
      label: "总花费",
      value: `¥${metrics.total_cost}`,
      percent: undefined,
      color: "linear-gradient(135deg,#8b5cf6,#6366f1)",
      extra: `${metrics.item_count} 个行程项`,
    },
  ];
  return (
    <div className="metric-row">
      {cards.map((c, i) => (
        <div key={c.label} className={`metric-card glass fade-up fade-up-delay-${i + 1}`}>
          <div className="metric-label">{c.label}</div>
          <div className="metric-value" style={{ background: c.color, WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent" }}>
            {c.value}
          </div>
          {c.percent !== undefined ? (
            <div className="metric-bar">
              <span style={{ width: `${c.percent}%` }} />
            </div>
          ) : (
            <div className="metric-extra">{c.extra}</div>
          )}
        </div>
      ))}
    </div>
  );
}
