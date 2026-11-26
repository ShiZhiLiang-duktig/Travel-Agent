/**
 * 出行天气预报（支持跨城多城市）。
 * - 顶部：扫描所有城市 / 日期的异常天气，列出「日期 + 城市 + 天气 + 原因」
 * - 下部：按城市分组展示每日预报卡，异常日高亮并标注原因
 * forecasts 为空时不渲染（降级策略：不影响主链路）。
 */
import type { WeatherDay, WeatherForecast, WeatherLevel } from "../api";

const LEVEL_RANK: Record<WeatherLevel, number> = { good: 0, warning: 1, danger: 2 };

const SOURCE_LABEL: Record<string, string> = {
  amap: "高德天气",
  "open-meteo": "Open-Meteo",
  demo: "示例数据（未配置天气源）",
};

/** km/h → 蒲福风力等级 */
function kmhToBeaufort(kmh: number): number {
  const thresholds = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
  let level = 0;
  for (const t of thresholds) if (kmh >= t) level += 1;
  return level;
}

/**
 * 从风力文本解析级数，兼容三种格式：
 * 「北风 6-7 级」→ 7；「16 km/h」→ 3（蒲福换算）；「12 m/s」→ 6
 */
function windNum(wind?: string): number {
  const s = wind || "";
  const lv = s.match(/(\d+)(?:\s*[-~]\s*(\d+))?\s*级/);
  if (lv) return Number(lv[2] || lv[1]);
  const kmh = s.match(/(\d+(?:\.\d+)?)\s*km\/h/i);
  if (kmh) return kmhToBeaufort(Number(kmh[1]));
  const ms = s.match(/(\d+(?:\.\d+)?)\s*m\/s/i);
  if (ms) {
    const v = Number(ms[1]);
    const thresholds = [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
    let n = 0;
    for (const t of thresholds) if (v >= t) n += 1;
    return n;
  }
  return 0;
}

interface Risk {
  date: string;
  weekday: string;
  city: string;
  weather: string;
  temp: string;
  level: WeatherLevel;
  reason: string;
  suggestion: string;
}
export type { Risk };

/** 单日风险识别：判断是否属于影响出行的异常天气 */
function dayRisk(city: string, d: WeatherDay): Risk | null {
  const max = Math.max(d.temp_max, d.temp_min);
  const min = Math.min(d.temp_max, d.temp_min);
  const wn = windNum(d.wind);
  const base = {
    date: d.date,
    weekday: d.weekday,
    city,
    weather: d.weather,
    temp: `${min}~${max}°`,
    suggestion: d.suggestion,
  };
  if (/雪/.test(d.weather))
    return { ...base, level: "danger", reason: "降雪", suggestion: "路面湿滑，优先室内并注意保暖" };
  if (/雷|暴雨|大雨/.test(d.weather))
    return { ...base, level: "danger", reason: "强降水", suggestion: "避免户外与山区，改为室内行程" };
  if (/雨/.test(d.weather))
    return { ...base, level: "warning", reason: "降雨", suggestion: "携带雨具，室内外灵活切换" };
  if (max >= 33)
    return { ...base, level: "warning", reason: "高温暴晒", suggestion: "避开正午，注意防晒补水" };
  if (min <= -5)
    return { ...base, level: "warning", reason: "严寒", suggestion: "注意保暖，减少长时间户外停留" };
  if (wn >= 6)
    return { ...base, level: "warning", reason: `大风 ${wn} 级`, suggestion: "注意防风，避免高处与临水项目" };
  if (d.level === "warning") return { ...base, level: "warning", reason: "低能见度" };
  if (d.level === "danger") return { ...base, level: "danger", reason: "恶劣天气" };
  return null;
}

function fmtUpdate(iso: string): string {
  try {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return "";
  }
}

/**
 * 汇总所有城市的异常天气（危险优先，其次按日期；同城同日去重）。
 * 导出给「天气调整提案」复用，避免两处判断口径不一致。
 */
export function detectWeatherRisks(forecasts: WeatherForecast[]): Risk[] {
  const list = forecasts.filter((f) => f && f.forecast.length);
  const risks: Risk[] = [];
  list.forEach((f) =>
    f.forecast.forEach((d) => {
      const r = dayRisk(f.city, d);
      if (r) risks.push(r);
    }),
  );
  risks.sort((a, b) => {
    const rank = LEVEL_RANK[b.level] - LEVEL_RANK[a.level];
    return rank !== 0 ? rank : a.date.localeCompare(b.date);
  });
  return risks.filter(
    (r, i) => risks.findIndex((x) => x.city === r.city && x.date === r.date) === i,
  );
}

export default function WeatherForecastView({
  forecasts,
  onAdjust,
}: {
  forecasts: WeatherForecast[];
  /** 传入后展示「生成室内替换方案」按钮（有行程时才传） */
  onAdjust?: () => void;
}) {
  const list = forecasts.filter((f) => f && f.forecast.length);
  if (!list.length) return null;

  // 汇总所有城市的异常天气：危险优先，其次按日期
  const uniq = detectWeatherRisks(list);
  const worst: WeatherLevel = uniq.reduce<WeatherLevel>(
    (acc, r) => (LEVEL_RANK[r.level] > LEVEL_RANK[acc] ? r.level : acc),
    "good",
  );

  const sources = Array.from(new Set(list.map((f) => SOURCE_LABEL[f.source] || f.source))).join(
    " / ",
  );
  const updated = list[0]?.updated_at ? ` · 更新于 ${fmtUpdate(list[0].updated_at)}` : "";

  return (
    <section className="weather-card glass fade-up">
      <div className="weather-head">
        <div className="section-title">
          <span style={{ marginRight: 6 }}>🌤️</span>
          <h3>出行天气预报</h3>
        </div>
        <div className="weather-meta">
          {sources}
          {updated}
        </div>
      </div>

      {/* 异常天气提醒：日期 + 城市 + 原因 */}
      {uniq.length > 0 ? (
        <div className={`wf-risk-box wf-risk-${worst}`}>
          <div className="wf-risk-title">
            ⚠️ 行程内有 {uniq.length} 处天气需注意
            {onAdjust && (
              <button type="button" className="btn-ghost wf-adjust-btn" onClick={onAdjust}>
                🌧 生成室内替换方案
              </button>
            )}
          </div>
          <ul className="wf-risk-list">
            {uniq.slice(0, 6).map((r) => (
              <li key={`${r.city}-${r.date}`} className={`wf-risk-item wf-risk-item-${r.level}`}>
                <span className="wf-risk-date">
                  {r.date.slice(5)} {r.weekday}
                </span>
                <span className="wf-risk-city">{r.city}</span>
                <span className="wf-risk-weather">
                  {r.weather} {r.temp}
                </span>
                <span className="wf-risk-reason">{r.reason}</span>
                <span className="wf-risk-tip">{r.suggestion}</span>
              </li>
            ))}
            {uniq.length > 6 && (
              <li className="wf-risk-more">等 {uniq.length} 处，建议优先安排室内景点</li>
            )}
          </ul>
        </div>
      ) : (
        <div className="weather-banner weather-good" style={{ background: "linear-gradient(90deg, rgba(16,185,129,0.14), rgba(16,185,129,0.04))" }}>
          ✅ 出行期间天气整体良好，适合户外游览
        </div>
      )}

      {/* 按城市分组的每日预报 */}
      {list.map((f) => (
        <div className="wf-city" key={f.city}>
          <div className="wf-city-name">📍 {f.city}</div>
          <div className="weather-days">
            {f.forecast.map((d, i) => {
              const r = dayRisk(f.city, d);
              return (
                <div key={d.date || i} className={`weather-day weather-day-${d.level}`}>
                  <div className="wd-date">
                    <span className="wd-md">{d.date ? d.date.slice(5) : ""}</span>
                    <span className="wd-week">{d.weekday}</span>
                  </div>
                  <div className="wd-icon">{d.icon}</div>
                  <div className="wd-weather">{d.weather}</div>
                  <div className="wd-temp">
                    <span className="wd-temp-max">{d.temp_max}°</span>
                    <span className="wd-temp-slash">/</span>
                    <span className="wd-temp-min">{d.temp_min}°</span>
                  </div>
                  {d.wind && <div className="wd-wind">💨 {d.wind}</div>}
                  {r && <div className="wd-risk">{r.reason}</div>}
                  <div className="wd-suggestion">{r ? r.suggestion : d.suggestion}</div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
