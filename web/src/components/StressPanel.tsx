/** 韧性压测详情 */
export default function StressPanel({ detail }: { detail: any }) {
  if (!detail) return null;
  const details: any[] = detail.details || [];
  const fragile: any[] = detail.fragile_points || [];
  return (
    <div className="rail-card glass">
      <div className="rail-card-title">
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--warning)" }} />
        韧性压测详情
      </div>

      <div style={{ display: "flex", gap: 16, marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>韧性分</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--accent)" }}>
            {Math.round(detail.resilience_score * 100)}%
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>存活</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--success)" }}>
            {detail.survived}/{detail.total}
          </div>
        </div>
      </div>

      {details.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {details.map((d: any) => (
            <div className="stress-row" key={d.id}>
              <span style={{ color: "var(--text-2)" }}>{d.id}</span>
              <span className={d.survived ? "pill green" : "pill red"} style={{ padding: "2px 8px" }}>
                {d.survived ? "通过" : "击穿"}
              </span>
            </div>
          ))}
        </div>
      )}

      {fragile.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: "var(--text-2)" }}>
            脆弱点
          </div>
          {fragile.map((f: any, i: number) => (
            <div className="fragile-item" key={i}>
              <span className="pill amber" style={{ marginRight: 6, padding: "1px 7px" }}>
                {f.disruption}
              </span>
              {f.reason}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
