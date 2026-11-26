/**
 * 城际交通卡片：展示三种方式与推荐，并把所选方式的班次 / 余票摊开给用户。
 *
 * 自驾没有班次与购票概念，所以不单独开「无需购票」说明块，也不做同车人数选择：
 * 油费 / 高速过路费 / 整车合计直接在「自驾」这张卡片里展开（选中时可见）。
 */
import type {
  AvailabilityStatus,
  ModeAvailability,
  TransportMode,
  TransportPlan,
} from "../api";

const MODE_ICON: Record<TransportMode, string> = {
  plane: "✈️",
  train: "🚄",
  drive: "🚗",
};

const STATUS_LABEL: Record<AvailabilityStatus, string> = {
  available: "有票",
  limited: "余票紧张",
  sold_out: "无票",
  not_required: "无需购票",
  unavailable: "未接入",
};

const STATUS_CLASS: Record<AvailabilityStatus, string> = {
  available: "ok",
  limited: "warn",
  sold_out: "danger",
  not_required: "neutral",
  unavailable: "muted",
};

function seatTone(status: string): string {
  if (/无票|售罄|无余票/.test(status)) return "danger";
  const m = status.match(/余票\s*(\d+)\s*张/);
  if (m) return Number(m[1]) <= 3 ? "warn" : "ok";
  if (/有票|充足|剩余\s*\d+\s*张|可订/.test(status)) return "ok";
  return "muted";
}

function formatChecked(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function AvailabilityBlock({ av }: { av: ModeAvailability }) {
  const tone = STATUS_CLASS[av.status];
  return (
    <div className="ic-availability">
      <div className="ic-avail-head">
        <span className={`ic-avail-status tone-${tone}`}>
          <span className="ic-avail-dot" />
          {STATUS_LABEL[av.status]}
        </span>
        <span className="ic-avail-source">
          {av.source}
          {av.checked_at ? ` · ${formatChecked(av.checked_at)} 查询` : ""}
        </span>
      </div>
      <div className="ic-avail-headline">{av.headline}</div>
      {!!av.entries?.length && (
        <div className="ic-avail-list">
          {av.entries.map((e, i) => (
            <div className="ic-avail-row" key={`${e.label}-${e.depart}-${i}`}>
              <span className="ic-avail-code">{e.label}</span>
              <span className="ic-avail-time">
                {e.depart} → {e.arrive}
              </span>
              {e.duration_min != null && (
                <span className="ic-avail-dur">
                  {Math.floor(e.duration_min / 60)}h
                  {String(e.duration_min % 60).padStart(2, "0")}m
                </span>
              )}
              <span className="ic-avail-seat">
                {e.seat}
                {e.price != null ? ` ¥${e.price}` : ""}
              </span>
              <span className={`ic-avail-seat-status tone-${seatTone(e.status)}`}>
                {e.status}
              </span>
              {e.sub && <span className="ic-avail-sub">{e.sub}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="ic-avail-detail">{av.detail}</div>
    </div>
  );
}

export default function IntercityPanel({
  plan,
  mode,
  setMode,
  loading,
  error,
}: {
  plan: TransportPlan | null;
  mode: TransportMode | null;
  setMode: (m: TransportMode) => void;
  loading: boolean;
  error: string;
}) {
  if (error) return <div className="notice-line">城际交通：{error}</div>;
  if (loading && !plan) {
    return (
      <section className="glass intercity fade-up">
        <div className="section-title">
          <span className="accent-bar" />
          <h3>城际交通</h3>
        </div>
        <div className="intercity-loading">正在计算两地距离与交通方式…</div>
      </section>
    );
  }
  if (!plan) return null;

  const activeMode = mode || plan.recommended;
  const activeAv = plan.availability?.[activeMode];

  return (
    <section className="glass intercity fade-up">
      <div className="section-title">
        <span className="accent-bar" />
        <h3>城际交通</h3>
        <span className="meta">
          <span className="pill">约 {plan.distance_km} km</span>
        </span>
      </div>
      {/* 三种方式各自带推荐徽标与价格，摘要句只是重复一遍，这里不再展示 */}
      <div className="intercity-options">
        {plan.options.map((o) => {
          const active = activeMode === o.mode;
          const av = plan.availability?.[o.mode];
          const bd = o.cost_breakdown;
          return (
            <button
              key={o.mode}
              type="button"
              className={`intercity-option${active ? " active" : ""}`}
              onClick={() => setMode(o.mode)}
            >
              <div className="ic-head">
                <span className="ic-icon">{MODE_ICON[o.mode]}</span>
                <span className="ic-label">{o.label}</span>
                {o.mode === plan.recommended && <span className="ic-badge">推荐</span>}
                {av && (
                  <span className={`ic-mini-avail tone-${STATUS_CLASS[av.status]}`}>
                    {STATUS_LABEL[av.status]}
                  </span>
                )}
              </div>
              <div className="ic-meta">
                {o.hours} 小时 · {bd ? `整车 ¥${bd.total}` : `¥${o.cost}/人`}
              </div>
              <div className="ic-note">{o.note}</div>

              {/* 自驾费用：直接摊在这张卡片里，选中时展开明细 */}
              {bd && active && (
                <div className="ic-cost-mini" title={bd.basis}>
                  <div className="ic-cost-mini-row">
                    <span>⛽ 油费</span>
                    <b>¥{bd.fuel}</b>
                  </div>
                  <div className="ic-cost-mini-row">
                    <span>🛣️ 高速过路费</span>
                    <b>¥{bd.toll}</b>
                  </div>
                  <div className="ic-cost-mini-row total">
                    <span>合计（整车）</span>
                    <b>¥{bd.total}</b>
                  </div>
                  <div className="ic-cost-mini-foot">估算：7.5L/100km · 0.45 元/km</div>
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* 自驾没有班次与余票，不需要「无需购票」说明块 */}
      {activeAv && activeMode !== "drive" && <AvailabilityBlock av={activeAv} />}

      <div className="intercity-foot">
        {plan.from} → {plan.to}，往返均按所选方式计入行程首尾两天
        {plan.availability?.train?.entries?.length
          ? "（高铁班次与余票为 12306 实时数据，其余为估算）"
          : "（距离与时长均为估算）"}
        。
      </div>
    </section>
  );
}
