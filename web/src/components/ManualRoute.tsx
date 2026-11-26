/**
 * 手动路线构建器（已选路线部分）：
 * - 选点入口已移到右侧地图的搜索面板，点击搜索结果即可加入这里
 * - 已选点可拖拽排序、分配到第 N 天、删除
 * - 底部：应用为本地行程 / 让 AI 基于此路线优化 / 清空
 * 地图打点由 App 根据 stops 实时驱动（数据流闭环：stops → MapView.points）。
 */
import { useMemo, useRef, useState } from "react";
import { Select } from "@douyinfe/semi-ui";
import type { ManualStop, ItineraryView, PoiSnapshot } from "../api";
import {
  autoSortStops,
  buildManualItinerary,
  resolveManualStopCost,
  routeDistanceKm,
} from "../route-utils";
import { dayColor } from "../meta";

interface Props {
  city: string;
  days: number;
  stops: ManualStop[];
  setStops: (s: ManualStop[]) => void;
  onApplyItinerary: (it: ItineraryView) => void;
  onOptimize: (base?: ManualStop[]) => void;
  /** 清空：恢复页面默认状态（城市 / 日期 / 偏好 / 已选路线） */
  onReset: () => void;
  running?: boolean;
  /** 当前 POI 目录：用于补齐旧草稿 / 搜索结果里缺失的费用。 */
  pois?: PoiSnapshot[];
  /** 同行人数：手动行程中的预算按总人数汇总。 */
  travelers?: number;
}

export default function ManualRoute(p: Props) {
  const [sortHint, setSortHint] = useState<{ before: number } | null>(null);
  const dragIdx = useRef<number | null>(null);

  const removeStop = (id: string) => {
    p.setStops(
      p.stops
        .filter((s) => s.id !== id)
        .map((s, i) => ({ ...s, order: i })),
    );
  };

  const setStopDay = (id: string, day: number) => {
    p.setStops(p.stops.map((s) => (s.id === id ? { ...s, day } : s)));
  };

  const moveStop = (from: number, to: number) => {
    if (from === to) return;
    const next = [...p.stops];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    p.setStops(next.map((s, i) => ({ ...s, order: i })));
  };

  const travelers = Math.max(1, Math.round(p.travelers ?? 1));
  const totalCost = p.stops.reduce(
    (sum, stop) => sum + resolveManualStopCost(stop, p.pois) * travelers,
    0,
  );
  const dayCount = new Set(p.stops.map((s) => s.day)).size;
  const totalKm = useMemo(() => routeDistanceKm(p.stops), [p.stops]);

  /** 路线优化：先用 2-opt 按城市聚簇快速排序，再交给 AI 复核（AI 有改动会出提案） */
  const handleRouteOptimize = () => {
    if (p.stops.length < 2) return;
    const r = autoSortStops(p.stops, p.days);
    p.setStops(r.stops);
    setSortHint({ before: r.beforeKm });
    p.onOptimize(r.stops);
  };

  return (
    <section className="manual-route glass fade-up">
      <div className="section-title">
        <span className="accent-bar" />
        <h3>已选路线</h3>
        <span className="meta">
          <span className="pill">{p.stops.length} 个点</span>
          <span className="pill">{dayCount} 天</span>
          <span className="pill blue">≈ {totalKm.toFixed(1)} km</span>
          <span className="pill violet">¥{totalCost}</span>
        </span>
      </div>

      <div className="mr-tip">
        在右侧地图上搜索景点 / 餐厅 / 酒店，点击结果或地图上的青色标记即可加入路线。
      </div>

      <div className="mr-selected">
        <div className="mr-selected-head">拖拽排序 · 分配天数</div>
        {p.stops.length === 0 ? (
          <div className="mr-empty">
            还没有选点。请先在地图上搜索并点击想去的地点。
          </div>
        ) : (
          <div className="mr-stop-list">
            {p.stops.map((s, i) => (
              <div
                key={s.id}
                className="mr-stop-row"
                draggable
                onDragStart={() => (dragIdx.current = i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIdx.current != null) moveStop(dragIdx.current, i);
                  dragIdx.current = null;
                }}
              >
                <span className="mr-handle">⋮⋮</span>
                <span
                  className="mr-stop-num"
                  style={{ background: dayColor(s.day) }}
                >
                  {i + 1}
                </span>
                <div className="mr-stop-info">
                  <div className="mr-stop-name">{s.name}</div>
                  <div className="mr-poi-tags">
                    <span className="item-tag">{s.category}</span>
                    <span className="item-tag">
                      ¥{Math.round(resolveManualStopCost(s, p.pois) * travelers)}
                    </span>
                    {s.city ? <span className="item-tag">{s.city}</span> : null}
                  </div>
                </div>
                <Select
                  value={s.day}
                  onChange={(v) => setStopDay(s.id, Number(v))}
                  style={{ width: 78 }}
                  optionList={Array.from({ length: p.days }, (_, k) => ({
                    label: `Day ${k + 1}`,
                    value: k + 1,
                  }))}
                />
                <button
                  type="button"
                  className="mr-del-btn"
                  onClick={() => removeStop(s.id)}
                  title="移除"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mr-actions">
        <button type="button" className="btn-ghost" onClick={p.onReset}>
          清空
        </button>
        <button
          type="button"
          className="btn-run"
          onClick={handleRouteOptimize}
          disabled={p.stops.length < 2 || p.running}
          style={{ background: "linear-gradient(135deg,#06b6d4,#4f46e5)" }}
          title="先用 2-opt 算法按城市聚簇快速排序，再让 AI 复核（AI 有改动会先给提案）"
        >
          {p.running ? "优化中…" : "⚡ 路线优化"}
        </button>
        <button
          type="button"
          className="btn-run"
          onClick={() =>
            p.onApplyItinerary(
              buildManualItinerary(p.stops, p.city, p.days, {
                travelers,
                pois: p.pois,
              }),
            )
          }
          disabled={p.stops.length === 0}
        >
          应用为行程
        </button>
      </div>
      {sortHint && (
        <div className="mr-sort-hint">
          ⚡ 2-opt 已重排：总距离 {sortHint.before.toFixed(1)} km →{" "}
          <b>{totalKm.toFixed(1)} km</b>
          {sortHint.before > 0.1 && totalKm < sortHint.before
            ? `（缩短 ${Math.round((1 - totalKm / sortHint.before) * 100)}%）`
            : "（当前顺序已较优）"}
        </div>
      )}
    </section>
  );
}
