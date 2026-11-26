/** 右侧事件流：Agent 实时执行时间线 */
import { useEffect, useRef } from "react";
import type { StreamEvent } from "../api";
import { eventLabel, eventColor } from "../meta";

function summarize(e: StreamEvent): string {
  const d = e.detail;
  if (!d) return "";
  switch (e.event) {
    case "start":
      return `${d.city} ${d.days} 天${d.mode ? ` · ${d.mode}` : ""}`;
    case "assistant":
      return (d.text ?? "").slice(0, 100);
    case "plan":
      return d.raw_request || "";
    case "solve":
      return `生成 ${d.item_count} 个行程项，总花费 ¥${d.itinerary?.total_cost}`;
    case "verify":
      return `${d.passed}/${d.total} 通过 · 满足率 ${Math.round(d.pass_rate * 100)}%`;
    case "stress":
      return `韧性 ${Math.round(d.resilience_score * 100)}% · ${d.survived}/${d.total} 通过`;
    case "replan":
      return `改动 ${d.changed_count} 节点：${(d.changed_items || []).join("、")}`;
    case "proposal":
      return `${d.tool} ${d.approved ? "已批准" : "被拦截"}（${d.action_level}）`;
    case "run_failed":
      return e.error || d.error || "运行失败";
    default:
      return "";
  }
}

export default function EventStream({
  events,
  running,
}: {
  events: StreamEvent[];
  running: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [events]);

  return (
    <div className="rail-card glass">
      <div className="rail-card-title">
        {running && <span className="live-dot" />}
        运行详情
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-3)", fontWeight: 400 }}>
          {events.length} 事件
        </span>
      </div>
      {events.length === 0 ? (
        <div className="empty-state" style={{ padding: "28px 12px" }}>
          <div className="big">⏳</div>
          <div style={{ fontSize: 12.5 }}>开始规划后这里实时滚动事件流</div>
        </div>
      ) : (
        <div className="event-list" ref={listRef}>
          {events.map((e, i) => (
            <div className="event-item" key={i}>
              <div className="event-dot" style={{ background: eventColor(e.event) }} />
              <div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                  <span className="event-name">{eventLabel(e.event)}</span>
                  {e.agent && <span className="event-agent">{e.agent}</span>}
                  <span className="event-time">{e.ts?.slice(11, 19)}</span>
                </div>
                {(() => {
                  const text = summarize(e);
                  return text ? <div className="event-detail">{text}</div> : null;
                })()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
