/** 扰动重规划结果：摘要 + 重规划后行程 + 可折叠基线对比 */
import { useState } from "react";
import type { ItineraryView } from "../api";
import ItineraryTimeline from "./ItineraryTimeline";

export default function ReplanPanel({
  detail,
  base,
  replanned,
}: {
  detail: any;
  base: ItineraryView | null;
  replanned: ItineraryView;
}) {
  const [showBase, setShowBase] = useState(false);
  return (
    <div className="fade-up" style={{ marginTop: 8 }}>
      <div className="section-title">
        <span className="accent-bar" />
        <h3>扰动重规划结果</h3>
        <span className="meta">
          <span className="pill violet">扰动：{detail.disruption}</span>
          <span className={detail.post_pass ? "pill green" : "pill red"}>
            重规划后约束{detail.post_pass ? "通过" : "未通过"}
          </span>
        </span>
      </div>

      <div className="glass" style={{ padding: "16px 20px", marginBottom: 16, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
        <SummaryItem label="改动节点数" value={`${detail.changed_count}`} />
        <SummaryItem label="改动景点" value={detail.changed_items?.join("、") || "—"} />
        <SummaryItem label="新增花费" value={`¥${detail.added_cost}`} />
        <SummaryItem label="需审批" value={detail.need_approval ? "是" : "否"} />
      </div>

      <ItineraryTimeline title="重规划后行程" itinerary={replanned} />

      {base && (
        <div style={{ marginTop: 12 }}>
          <button
            className="btn-ghost"
            style={{ padding: "6px 14px", borderRadius: 10, cursor: "pointer" }}
            onClick={() => setShowBase((v) => !v)}
          >
            {showBase ? "收起基线行程" : "对比基线行程"}
          </button>
          {showBase && (
            <div style={{ marginTop: 12, opacity: 0.85 }}>
              <ItineraryTimeline title="基线行程（扰动前）" itinerary={base} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11.5, color: "var(--text-3)", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4, color: "var(--text)" }}>{value}</div>
    </div>
  );
}
