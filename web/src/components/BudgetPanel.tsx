/**
 * 预算明细面板：把「只有一个总预算」升级为分项 + 人均 + 超支预警。
 * 数据源全部是本地已有字段（行程项 cost / POI 分类 / 城际交通估算），不依赖新接口。
 */
import { useMemo } from "react";
import type { IntercityLegs, ItineraryView, PoiSnapshot } from "../api";

const CATEGORY_COLORS: Record<string, string> = {
  景点门票: "#4f46e5",
  餐饮: "#f59e0b",
  住宿: "#10b981",
  城际交通: "#06b6d4",
  其他: "#94a3b8",
};

function classify(poi: string, source: string, category?: string): string {
  const text = `${category || ""} ${source || ""} ${poi}`;
  if (/餐|饭|食|餐厅|小吃|咖啡/.test(text)) return "餐饮";
  if (/酒店|住宿|民宿|客栈/.test(text)) return "住宿";
  if (/交通|车站|机场|地铁|公交|打车|租车/.test(text)) return "城际交通";
  if (/景点|景区|博物馆|公园|展览|馆|寺|塔|山|湖/.test(text)) return "景点门票";
  return "其他";
}

export default function BudgetPanel({
  itinerary,
  pois,
  intercity,
  budget,
  travelers = 1,
}: {
  itinerary: ItineraryView;
  pois?: PoiSnapshot[];
  intercity?: IntercityLegs;
  budget?: number;
  travelers?: number;
}) {
  const data = useMemo(() => {
    const cat = new Map<string, string>();
    pois?.forEach((p) => cat.set(p.name, p.category || ""));
    const totals = new Map<string, number>();
    let itemsCost = 0;
    itinerary.items.forEach((it) => {
      const cost = Number(it.cost) || 0;
      itemsCost += cost;
      const k = classify(it.poi, it.source, cat.get(it.poi));
      totals.set(k, (totals.get(k) || 0) + cost);
    });
    const n = Math.max(1, travelers);
    const icCost = intercity
      ? (Number(intercity.outbound.cost) + Number(intercity.inbound.cost)) * n
      : 0;
    if (icCost > 0) totals.set("城际交通", (totals.get("城际交通") || 0) + icCost);
    const spend = itemsCost + icCost;
    const rows = Array.from(totals.entries())
      .filter(([, v]) => v > 0)
      .map(([name, value]) => ({
        name,
        value: Math.round(value),
        pct: spend > 0 ? Math.round((value / spend) * 100) : 0,
        color: CATEGORY_COLORS[name] || CATEGORY_COLORS.其他,
      }))
      .sort((a, b) => b.value - a.value);
    return { rows, spend: Math.round(spend), perPerson: Math.round(spend / n), itemsCost };
  }, [itinerary, pois, intercity, travelers]);

  const over = budget ? data.spend - budget : 0;
  const usage = budget && budget > 0 ? Math.round((data.spend / budget) * 100) : null;

  return (
    <section className="glass budget-panel fade-up">
      <div className="section-title">
        <span className="accent-bar" />
        <h3>预算明细</h3>
        <span className="meta">
          <span className="pill">人均约 ¥{data.perPerson}</span>
          {budget ? (
            <span className={`pill ${over > 0 ? "pill-danger" : "green"}`}>
              {over > 0 ? `超预算 ¥${over}` : `预算内剩 ¥${-over}`}
            </span>
          ) : (
            <span className="pill">未设预算</span>
          )}
        </span>
      </div>

      <div className="budget-total">
        <div>
          <div className="field-label">预计总花费</div>
          <div className="budget-amount">¥{data.spend.toLocaleString()}</div>
        </div>
        {budget ? (
          <div className="budget-budget">
            <div className="field-label">设定预算 ¥{budget.toLocaleString()}</div>
            <div className="budget-track">
              <div
                className={`budget-fill${over > 0 ? " over" : ""}`}
                style={{ width: `${Math.min(100, usage || 0)}%` }}
              />
            </div>
            <div className="budget-usage">已用 {usage}%</div>
          </div>
        ) : null}
      </div>

      <div className="budget-rows">
        {data.rows.length === 0 && <div className="budget-empty">行程项暂无费用数据</div>}
        {data.rows.map((r) => (
          <div className="budget-row" key={r.name}>
            <span className="budget-name">
              <i style={{ background: r.color }} />
              {r.name}
            </span>
            <span className="budget-bar">
              <span style={{ width: `${r.pct}%`, background: r.color }} />
            </span>
            <span className="budget-value">¥{r.value.toLocaleString()}</span>
            <span className="budget-pct">{r.pct}%</span>
          </div>
        ))}
      </div>
      {intercity && (
        <div className="budget-note">
          含往返城际交通（按所选方式 × {Math.max(1, travelers)} 人估算）；实际票价以购票平台为准。
        </div>
      )}
    </section>
  );
}
