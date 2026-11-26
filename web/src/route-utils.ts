/**
 * 路线相关工具：偏好 → requirement、手动路线 → requirement、手动 stops → 本地行程。
 * 不改动后端协议，仅在前端把用户输入整理成自然语言喂给 AI，或本地生成可渲染的行程。
 */
import type {
  ManualStop,
  TravelPreferences,
  ItineraryView,
  ItineraryItemView,
  PoiSnapshot,
} from "./api";
import { transportModeLabel } from "./meta";

const PACE_TEXT: Record<string, string> = {
  relaxed: "行程节奏宽松，多安排休息",
  moderate: "行程节奏适中",
  tight: "行程紧凑，尽量多打卡景点",
};

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** 人群标签对应的人数估算；情侣 / 朋友按两人计。 */
export function estimateTravelerCount(group?: string[]): number {
  if (!Array.isArray(group) || group.length === 0) return 1;
  let count = 0;
  for (const tag of group) {
    if (tag === "情侣" || tag === "朋友") count += 2;
    else count += 1;
  }
  return Math.max(1, count);
}

/**
 * 手动路线单项单价：优先使用选点时保存的值；
 * 旧草稿或第三方搜索结果缺值时，再按 id / 名称从当前 POI 目录补齐。
 */
export function resolveManualStopCost(
  stop: ManualStop,
  pois?: PoiSnapshot[],
): number {
  const saved = Number(stop.cost);
  if (Number.isFinite(saved) && saved > 0) return saved;
  const matched = pois?.find(
    (poi) => poi.id === stop.id || poi.name === stop.name,
  );
  const fromCatalog = Number(matched?.price_per_person);
  return Number.isFinite(fromCatalog) && fromCatalog > 0 ? fromCatalog : 0;
}

/**
 * 按「天 → 开始时间 → 结束时间」排序行程项。
 * 时间轴、分段交通、地图编号统一用这个函数，保证三处顺序一致。
 */
export function sortItineraryItems<T extends { day: number; start: string; end?: string }>(
  items: T[],
): T[] {
  return [...items].sort(
    (a, b) =>
      a.day - b.day ||
      a.start.localeCompare(b.start) ||
      (a.end || "").localeCompare(b.end || ""),
  );
}

/** 把旅行偏好拼成自然语言 requirement（喂给 AI 的 prompt） */
export function buildPreferenceRequirement(
  prefs: TravelPreferences,
  city: string,
  days: number,
  extra?: string,
  weatherSummary?: string,
): string {
  const parts: string[] = [];
  if (prefs.group.length) parts.push(`出行人群：${prefs.group.join("、")}`);
  const modeLabel = transportModeLabel(prefs.transport_mode);
  if (modeLabel) parts.push(`城际出行方式优先选择${modeLabel}`);
  if (prefs.budget) parts.push(`总预算约 ¥${prefs.budget}`);
  if (prefs.pace) parts.push(PACE_TEXT[prefs.pace] || "");
  if (prefs.afternoon_indoor) parts.push("下午尽量安排室内活动");
  if (prefs.must_have_lunch) parts.push("午休不能省，需安排回酒店午休");
  if (prefs.must_visit.length) parts.push(`必去景点：${prefs.must_visit.join("、")}`);
  if (prefs.avoid.length) parts.push(`尽量避开：${prefs.avoid.join("、")}`);
  if (/[、,，]/.test(city))
    parts.push("这是跨城市行程，请合理分配各城市天数并考虑城际交通");

  const head = prefs.group.length
    ? `带${prefs.group.join("、")}去${city}玩${days}天`
    : `去${city}玩${days}天`;
  const tail = extra ? `补充：${extra}` : "";
  const weather = weatherSummary ? ` ${weatherSummary}` : "";
  return [head, ...parts.filter(Boolean), tail].filter(Boolean).join("，") + "。" + weather;
}

/** 把手动选点的顺序拼成 requirement，让 AI 基于此顺序优化行程 */
export function buildManualRouteRequirement(
  stops: ManualStop[],
  city: string,
  days: number,
  prefs: TravelPreferences,
  extra?: string,
  weatherSummary?: string,
): string {
  const byDay = new Map<number, ManualStop[]>();
  stops.forEach((s) => {
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day)!.push(s);
  });
  const lines: string[] = [];
  for (let d = 1; d <= days; d++) {
    const arr = (byDay.get(d) || []).sort((a, b) => a.order - b.order);
    if (arr.length) lines.push(`Day${d}：${arr.map((s) => s.name).join(" → ")}`);
  }
  const base = buildPreferenceRequirement(prefs, city, days, extra, weatherSummary);
  if (!lines.length) return base;
  return `${base} 我已经选好这些景点并排好了顺序：${lines.join(
    "；",
  )}。请只在我选定的这些景点范围内优化（不要新增或替换景点）：按城市聚簇，先把同一个城市的景点连续逛完，再前往下一个城市，避免跨城来回折返；同时调整游玩时间、餐饮与午休，并验证约束。`;
}

/**
 * 按 AI 返回的行程顺序重排用户已选景点：
 * - 只用用户选过的景点，AI 新增的景点会被忽略
 * - 匹配到 2 个以上才采用，否则保持原顺序
 * - 未被 AI 排到的原选点追加到末尾，保证不丢点
 */
export function reorderStopsByItinerary(
  stops: ManualStop[],
  itinerary: ItineraryView,
): ManualStop[] {
  const byName = new Map<string, ManualStop>();
  stops.forEach((s) => byName.set(s.name, s));

  const ordered: ManualStop[] = [];
  const used = new Set<string>();
  const sorted = [...itinerary.items].sort(
    (a, b) => a.day - b.day || a.start.localeCompare(b.start),
  );
  const findStop = (poi: string): ManualStop | undefined => {
    const exact = byName.get(poi);
    if (exact) return exact;
    // AI 偶尔会给名称加前缀/后缀，用双向包含做一次容错匹配
    return stops.find((s) => poi.includes(s.name) || s.name.includes(poi));
  };
  for (const it of sorted) {
    const s = findStop(it.poi);
    if (s && !used.has(s.id)) {
      used.add(s.id);
      ordered.push({ ...s, day: it.day, order: ordered.length });
    }
  }
  if (ordered.length < 2) return stops;

  stops.forEach((s) => {
    if (!used.has(s.id)) ordered.push({ ...s, order: ordered.length });
  });
  return ordered;
}

/** 每城每天最多安排的点数，超过则顺延到次日 */
const STOPS_PER_DAY = 3;

/**
 * 本地城市聚簇优化：把同一城市的景点连续安排，避免「苏州→南京→苏州」这种折返。
 * - 城市顺序按用户在列表中首次选择的顺序
 * - 同城超过 STOPS_PER_DAY 个点则顺延到次日
 * - 只有一个城市时保持原顺序
 */
export function optimizeStopsLocally(stops: ManualStop[]): ManualStop[] {
  if (stops.length < 2) return stops;
  const sorted = [...stops].sort((a, b) => a.order - b.order);
  const cityOrder: string[] = [];
  const groups = new Map<string, ManualStop[]>();
  for (const s of sorted) {
    const c = (s.city || "未标注").trim();
    if (!groups.has(c)) {
      groups.set(c, []);
      cityOrder.push(c);
    }
    groups.get(c)!.push(s);
  }
  // 未标注城市或只有一个城市，无从聚簇
  if (cityOrder.length < 2 || cityOrder.includes("未标注")) return stops;

  const out: ManualStop[] = [];
  let day = 1;
  let prevCity = "";
  for (const c of cityOrder) {
    if (prevCity && c !== prevCity) day += 1;
    groups.get(c)!.forEach((s, i) => {
      if (i > 0 && i % STOPS_PER_DAY === 0) day += 1;
      out.push({ ...s, day, order: out.length });
    });
    prevCity = c;
  }
  return out;
}

/** 地球平均半径（km），用于直线距离估算 */
const EARTH_R = 6371;

/** 两点球面距离（km）：路线总距离与 2-opt 优化都用它 */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

/** 按 day + order 顺序统计整条路线的总直线距离（km） */
export function routeDistanceKm(stops: ManualStop[]): number {
  if (stops.length < 2) return 0;
  const sorted = [...stops].sort((a, b) => a.day - b.day || a.order - b.order);
  let sum = 0;
  for (let i = 1; i < sorted.length; i++) sum += haversineKm(sorted[i - 1], sorted[i]);
  return sum;
}

/**
 * 2-opt 开放路径优化（首点固定，不回流到起点）：
 * 反复尝试反转区间 [i, j]，若总距离变短就接受，直到无改进或达到轮数上限。
 */
function twoOptOpenPath<T extends { lat: number; lng: number }>(
  path: T[],
  maxPass = 12,
): T[] {
  if (path.length < 4) return path;
  let best = [...path];
  let improved = true;
  let pass = 0;
  while (improved && pass < maxPass) {
    improved = false;
    pass += 1;
    for (let i = 1; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const a = best[i - 1];
        const b = best[i];
        const c = best[j];
        const d = best[j + 1];
        // 只比较被反转影响的两条边：a→b / c→d 变成 a→c / b→d
        const before = haversineKm(a, b) + (d ? haversineKm(c, d) : 0);
        const after = haversineKm(a, c) + (d ? haversineKm(b, d) : 0);
        if (after + 1e-9 < before) {
          best = [
            ...best.slice(0, i),
            ...best.slice(i, j + 1).reverse(),
            ...best.slice(j + 1),
          ];
          improved = true;
        }
      }
    }
  }
  return best;
}

export interface AutoSortResult {
  stops: ManualStop[];
  beforeKm: number;
  afterKm: number;
}

/**
 * 自动排序：先按城市聚簇（同城连续逛完），再在每座城市内部用 2-opt 缩短距离；
 * 最后按「每城每天最多 STOPS_PER_DAY 个点、换城进入新的一天」重新分配 day。
 */
export function autoSortStops(stops: ManualStop[], days: number): AutoSortResult {
  const beforeKm = routeDistanceKm(stops);
  if (stops.length < 2) return { stops, beforeKm, afterKm: beforeKm };

  const sorted = [...stops].sort((a, b) => a.day - b.day || a.order - b.order);
  const cityOrder: string[] = [];
  const groups = new Map<string, ManualStop[]>();
  for (const s of sorted) {
    const c = (s.city || "未标注").trim() || "未标注";
    if (!groups.has(c)) {
      groups.set(c, []);
      cityOrder.push(c);
    }
    groups.get(c)!.push(s);
  }

  const ordered: ManualStop[] = [];
  for (const c of cityOrder) ordered.push(...twoOptOpenPath(groups.get(c)!));

  const maxDay = Math.max(1, days);
  const out: ManualStop[] = [];
  let day = 1;
  let prevCity = "";
  let sameCityCount = 0;
  for (const s of ordered) {
    const c = (s.city || "未标注").trim() || "未标注";
    if (prevCity && c !== prevCity) {
      day += 1;
      sameCityCount = 0;
    } else if (sameCityCount > 0 && sameCityCount % STOPS_PER_DAY === 0) {
      day += 1;
    }
    out.push({ ...s, day: Math.min(day, maxDay), order: out.length });
    sameCityCount += 1;
    prevCity = c;
  }
  return { stops: out, beforeKm, afterKm: routeDistanceKm(out) };
}

/** 把天气预报压缩成一段自然语言（喂给 AI，让其规划时考虑天气） */
export function summarizeWeather(
  forecast:
    | import("./api").WeatherForecast
    | import("./api").WeatherForecast[]
    | null,
): string {
  const list = Array.isArray(forecast) ? forecast : forecast ? [forecast] : [];
  const parts = list
    .filter((f) => f.forecast.length)
    .map((f) => {
      const lines = f.forecast.map(
        (d) => `${d.date.slice(5)} ${d.weekday} ${d.weather} ${d.temp_min}~${d.temp_max}℃`,
      );
      return `【${f.city}】${lines.join("；")}`;
    });
  if (!parts.length) return "";
  return `出行期间天气预报：${parts.join(" ")}。请据此合理安排室内外景点，雨雪天优先室内。`;
}

/** 把手动 stops 生成本地 ItineraryView（前端分配时间，供行程卡 + 地图渲染） */
export function buildManualItinerary(
  stops: ManualStop[],
  city: string,
  days: number,
  options: {
    travelers?: number;
    pois?: PoiSnapshot[];
  } = {},
): ItineraryView {
  const travelers = Math.max(1, Math.round(options.travelers ?? 1));
  const byDay = new Map<number, ManualStop[]>();
  stops.forEach((s) => {
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day)!.push(s);
  });
  const items: ItineraryItemView[] = [];
  let total = 0;

  for (let d = 1; d <= days; d++) {
    const arr = (byDay.get(d) || []).sort((a, b) => a.order - b.order);
    if (!arr.length) continue;
    let minutes = 9 * 60; // 每天 09:00 开始
    arr.forEach((s) => {
      const visit = s.visit_minutes ?? 90;
      const startH = Math.floor(minutes / 60);
      const startM = minutes % 60;
      minutes += visit;
      const endH = Math.floor(minutes / 60);
      const endM = minutes % 60;
      const walking = s.walking_minutes ?? 15;
      minutes += walking; // 段间步行
      const unitCost = resolveManualStopCost(s, options.pois);
      const itemCost = round2(unitCost * travelers);
      items.push({
        day: d,
        start: `${pad(startH)}:${pad(startM)}`,
        end: `${pad(endH)}:${pad(endM)}`,
        poi: s.name,
        // 优先用地点自身城市（支持跨城手选），无城市信息时回落到传入城市
        city: s.city || city,
        walking_min: walking,
        stairs: s.stairs ?? 0,
        indoor: s.indoor ?? "mixed",
        cost: itemCost,
        is_backup: false,
        source: s.category || "手动",
      });
      total += itemCost;
    });
  }
  return { label: "手动路线", days, total_cost: round2(total), items };
}

/** 把手动 stops 转成地图打点用的 MapPoint（已有坐标，不依赖 coordMap） */
export function manualStopsToMapPoints(stops: ManualStop[]): import("./api").MapPoint[] {
  return [...stops]
    .sort((a, b) => (a.day - b.day) * 1000 + (a.order - b.order))
    .map((s, i) => ({
      key: `manual-${s.id}`,
      name: s.name,
      day: s.day,
      start: `#${i + 1}`,
      end: "",
      lat: s.lat,
      lng: s.lng,
      indoor: s.indoor,
      walking_min: s.walking_minutes,
    }));
}
