/** 行程时间线：按天分组的卡片（替代原表格，更具叙事感与高级感） */
import { useMemo, useState } from "react";
import type { IntercityLeg, IntercityLegs, ItineraryView, PoiSnapshot } from "../api";
import { dayColor, indoorLabel } from "../meta";
import { segmentKey, useItinerarySegments } from "../segments";
import { sortItineraryItems } from "../route-utils";

const LEG_ICON: Record<string, string> = { plane: "✈️", train: "🚄", drive: "🚗" };

/** 单条往返交通：在首尾两天的卡片里作为一行展示 */
function LegRow({ leg }: { leg: IntercityLeg }) {
  return (
    <div className="item-seg item-seg-transport">
      <span className="item-seg-line" />
      <span className="item-seg-text">
        {LEG_ICON[leg.mode] || "🚌"} {leg.label}：{leg.from} → {leg.to} · 约 {leg.hours} 小时 · ¥
        {leg.cost}/人
        <span className="item-seg-tag">往返交通（估算）</span>
      </span>
    </div>
  );
}

export default function ItineraryTimeline({
  title,
  itinerary,
  pois,
  intercity,
  onEdit,
}: {
  title?: string;
  itinerary: ItineraryView;
  /** 传入 POI 快照后显示相邻两点的分段交通（距离 / 时长） */
  pois?: PoiSnapshot[];
  /** 出发城市 → 目的地的往返交通，写入第 1 天与最后一天 */
  intercity?: IntercityLegs;
  /** 传入后开启轻量编辑（删除行程项 / 改天），带 10 步撤销 */
  onEdit?: (next: ItineraryView) => void;
}) {
  const segments = useItinerarySegments(itinerary, pois);
  const [history, setHistory] = useState<ItineraryView[]>([]);

  /** 统一出口：先压栈当前快照，再写回新行程 */
  const commit = (nextItems: typeof itinerary.items) => {
    if (!onEdit) return;
    setHistory((h) => [...h.slice(-9), itinerary]);
    onEdit({
      ...itinerary,
      items: nextItems,
      total_cost: Math.round(nextItems.reduce((s, i) => s + (i.cost || 0), 0)),
    });
  };

  const undo = () => {
    if (!onEdit || !history.length) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    onEdit(prev);
  };

  const moveItem = (gi: number, delta: number) => {
    const item = itinerary.items[gi];
    if (!item) return;
    const day = Math.min(itinerary.days, Math.max(1, item.day + delta));
    if (day === item.day) return;
    commit(itinerary.items.map((it, i) => (i === gi ? { ...it, day } : it)));
  };

  const removeItem = (gi: number) => {
    commit(itinerary.items.filter((_, i) => i !== gi));
  };
  const days = useMemo(() => {
    const map = new Map<number, typeof itinerary.items>();
    sortItineraryItems(itinerary.items.filter((i) => !i.is_backup)).forEach((i) => {
        if (!map.has(i.day)) map.set(i.day, []);
        map.get(i.day)!.push(i);
      });
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  }, [itinerary]);

  return (
    <div className="fade-up">
      {title && (
        <div className="section-title">
          <span className="accent-bar" />
          <h3>{title}</h3>
          <span className="meta">
            <span className="pill">{itinerary.days} 天</span>
            <span className="pill green">总花费 ¥{itinerary.total_cost}</span>
            {onEdit && history.length > 0 && (
              <button type="button" className="it-undo" onClick={undo} title="撤销上一步编辑">
                ↩ 撤销
              </button>
            )}
          </span>
        </div>
      )}
      {days.map(([day, items]) => {
        const color = dayColor(day);
        const dayCost = items.reduce((s, i) => s + (i.cost || 0), 0);
        return (
          <div key={day} className="day-card glass">
            <div className="day-head">
              <div className="day-badge" style={{ background: color }}>
                D{day}
              </div>
              <div>
                <div className="day-title">第 {day} 天 · {items.length} 个行程项</div>
                <div className="day-sub">当日花费 ¥{dayCost}</div>
              </div>
            </div>
            <div className="item-list">
              {intercity && intercity.outbound.day === day && (
                <LegRow leg={intercity.outbound} />
              )}
              {items.map((it, idx) => {
                const seg = segments[segmentKey(day, it.start, it.poi)];
                const globalIdx = itinerary.items.indexOf(it);
                return (
                  <div key={`${day}-${idx}`}>
                    {idx > 0 && seg && (
                      <div className="item-seg">
                        <span className="item-seg-line" />
                        <span className="item-seg-text">
                          🚶 {seg.km.toFixed(1)} km · {seg.minutes} 分钟
                          {seg.source === "estimate" ? "（估算）" : ""}
                        </span>
                      </div>
                    )}
                    <div className="item-row">
                      <div className="item-time">
                        {it.start}
                        <br />
                        <span style={{ color: "var(--text-3)", fontWeight: 400 }}>{it.end}</span>
                      </div>
                      <div className="item-body">
                        <div className="item-dot" style={{ background: color }} />
                        <div className="item-main">
                          <div className="item-name">{it.poi}</div>
                          <div className="item-tags">
                            <span className="item-tag">步行 {it.walking_min} 分</span>
                            <span className="item-tag">台阶 {it.stairs}</span>
                            <span className="item-tag">{indoorLabel(it.indoor)}</span>
                            <span className="item-tag">¥{it.cost}</span>
                            <span className="item-tag" style={{ opacity: 0.7 }}>
                              {it.source}
                            </span>
                          </div>
                        </div>
                        {onEdit && (
                          <div className="item-actions">
                            <button
                              type="button"
                              title="移到前一天"
                              disabled={it.day <= 1}
                              onClick={() => moveItem(globalIdx, -1)}
                            >
                              ←日
                            </button>
                            <button
                              type="button"
                              title="移到后一天"
                              disabled={it.day >= itinerary.days}
                              onClick={() => moveItem(globalIdx, 1)}
                            >
                              日→
                            </button>
                            <button
                              type="button"
                              title="从行程中移除"
                              onClick={() => removeItem(globalIdx)}
                            >
                              ✕
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {intercity && intercity.inbound.day === day && <LegRow leg={intercity.inbound} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
