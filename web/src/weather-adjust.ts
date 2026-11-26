/**
 * 天气调整建议：把异常天气日里的户外行程项替换为同城室内景点，
 * 生成一份「提案」交给用户在确认卡片里决定应用或放弃。
 */
import type { ItineraryView, PoiSnapshot, WeatherForecast } from "./api";
import type { ProposalChange } from "./proposal";
import { detectWeatherRisks } from "./components/WeatherForecast";

export interface WeatherAdjustment {
  title: string;
  summary: string;
  changes: ProposalChange[];
  /** 应用后的行程（新对象，不修改入参） */
  next: ItineraryView;
}

/** 日期差 → 行程第几天（1 起）；无法解析返回 NaN */
function dayIndexOf(startDate: string, date: string): number {
  const a = new Date(`${startDate}T00:00:00`).getTime();
  const b = new Date(`${date}T00:00:00`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * 生成天气调整提案：
 * - 只针对行程范围内、且天气异常的日期
 * - 只替换非室内项（outdoor / mixed），室内项保持不动
 * - 替换候选来自同城、未被行程占用的室内 POI
 */
export function buildWeatherAdjustment(opts: {
  itinerary: ItineraryView;
  weather: WeatherForecast[];
  pois: PoiSnapshot[];
  startDate: string;
}): WeatherAdjustment | null {
  const { itinerary, weather, pois, startDate } = opts;
  if (!startDate || !itinerary.items.length) return null;

  const risks = detectWeatherRisks(weather).filter((r) => r.level !== "good");
  if (!risks.length) return null;

  const riskyDays = new Map<number, string>();
  for (const r of risks) {
    const d = dayIndexOf(startDate, r.date);
    if (d >= 1 && d <= itinerary.days && !riskyDays.has(d)) {
      riskyDays.set(d, `${r.date.slice(5)} ${r.city} ${r.reason}`);
    }
  }
  if (!riskyDays.size) return null;

  const usedNames = new Set(itinerary.items.map((i) => i.poi));
  const indoorPool = pois.filter((p) => p.indoor === "indoor");
  const changes: ProposalChange[] = [];
  const next: ItineraryView = {
    ...itinerary,
    items: itinerary.items.map((i) => ({ ...i })),
  };

  for (const it of next.items) {
    if (it.is_backup || !riskyDays.has(it.day) || it.indoor === "indoor") continue;
    const cand = indoorPool.find((p) => p.city === it.city && !usedNames.has(p.name));
    if (!cand) continue;
    usedNames.add(cand.name);
    changes.push({
      kind: "replace",
      day: it.day,
      from: it.poi,
      to: cand.name,
      reason: riskyDays.get(it.day) || "天气不适合户外",
    });
    it.poi = cand.name;
    it.indoor = "indoor";
    it.source = "天气替换";
    it.cost = Number(cand.price_per_person) || it.cost;
    if (Number.isFinite(Number(cand.walking_minutes))) {
      it.walking_min = Number(cand.walking_minutes);
    }
  }

  if (!changes.length) return null;
  return {
    title: "天气调整建议",
    summary: `行程内有 ${changes.length} 个户外项目处于异常天气日，建议替换为室内景点`,
    changes,
    next,
  };
}
