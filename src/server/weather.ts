/**
 * 出行天气预报服务（面向用户）。
 *
 * 分层（经验沉淀）：后端做「字段归一化 + 业务分级」，前端只依赖稳定轻量 DTO；
 * 降级策略用「返回 null → 前端不渲染」而非展示错误态，避免影响主链路。
 *
 * 数据源优先级：
 *   1. 高德天气 /v3/weather/weatherInfo（国内准，需 AMAP_KEY，最多 4 天预报）
 *   2. Open-Meteo（免费、无需 key、最多 16 天，用城市首个 POI 经纬度查询）
 *   3. 全部失败 → 返回 null
 */
import { amapWeather } from "./amap.js";
import { load_pois } from "../data/snapshot.js";

export type WeatherLevel = "good" | "warning" | "danger";

export interface WeatherDay {
  date: string; // YYYY-MM-DD
  weekday: string; // 周一 … 周日
  weather: string; // 中文天气描述
  icon: string; // emoji
  temp_min: number;
  temp_max: number;
  wind: string; // 风力/风向描述
  level: WeatherLevel;
  suggestion: string; // 出行建议
}

export interface WeatherForecast {
  city: string;
  source: "amap" | "open-meteo" | "demo";
  updated_at: string;
  forecast: WeatherDay[];
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const weekdayOf = (dateStr: string) => {
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? "" : WEEKDAYS[d.getDay()];
};

/** WMO weathercode → 图标 / 等级 / 建议（表驱动，集中维护） */
const WMO: Record<number, { weather: string; icon: string; level: WeatherLevel; suggestion: string }> = {
  0: { weather: "晴", icon: "☀️", level: "good", suggestion: "天气晴好，适合户外游览" },
  1: { weather: "大部晴朗", icon: "🌤️", level: "good", suggestion: "天气不错，可正常出行" },
  2: { weather: "局部多云", icon: "⛅", level: "good", suggestion: "多云天气，体感舒适" },
  3: { weather: "阴", icon: "☁️", level: "good", suggestion: "阴天，注意早晚温差" },
  45: { weather: "雾", icon: "🌫️", level: "warning", suggestion: "有雾，能见度低，注意出行安全" },
  48: { weather: "雾凇", icon: "🌫️", level: "warning", suggestion: "有雾凇，路面可能湿滑" },
  51: { weather: "小毛毛雨", icon: "🌦️", level: "warning", suggestion: "零星小雨，建议带伞" },
  53: { weather: "毛毛雨", icon: "🌦️", level: "warning", suggestion: "小雨持续，建议带伞" },
  55: { weather: "大毛毛雨", icon: "🌧️", level: "warning", suggestion: "雨势较大，优先安排室内景点" },
  56: { weather: "冻毛毛雨", icon: "🌧️", level: "danger", suggestion: "冻雨，路面结冰，谨慎出行" },
  57: { weather: "强冻毛毛雨", icon: "🌧️", level: "danger", suggestion: "强冻雨，尽量避免户外活动" },
  61: { weather: "小雨", icon: "🌦️", level: "warning", suggestion: "小雨，建议带伞，备室内备选" },
  63: { weather: "中雨", icon: "🌧️", level: "warning", suggestion: "雨势明显，优先室内景点" },
  65: { weather: "大雨", icon: "🌧️", level: "danger", suggestion: "大雨，减少户外活动，注意积水" },
  66: { weather: "冻雨", icon: "🌧️", level: "danger", suggestion: "冻雨，路面结冰，谨慎出行" },
  67: { weather: "强冻雨", icon: "🌧️", level: "danger", suggestion: "强冻雨，尽量避免外出" },
  71: { weather: "小雪", icon: "🌨️", level: "warning", suggestion: "小雪，注意保暖防滑" },
  73: { weather: "中雪", icon: "🌨️", level: "danger", suggestion: "中雪，路面湿滑，减少外出" },
  75: { weather: "大雪", icon: "❄️", level: "danger", suggestion: "大雪，建议取消或调整户外活动" },
  77: { weather: "雪粒", icon: "🌨️", level: "warning", suggestion: "有雪粒，注意防滑保暖" },
  80: { weather: "小阵雨", icon: "🌦️", level: "warning", suggestion: "阵雨，建议随身携带雨具" },
  81: { weather: "中阵雨", icon: "🌧️", level: "warning", suggestion: "阵雨较频，灵活安排室内外" },
  82: { weather: "大阵雨", icon: "🌧️", level: "danger", suggestion: "强阵雨，避免户外长时间停留" },
  85: { weather: "小阵雪", icon: "🌨️", level: "warning", suggestion: "阵雪，注意保暖防滑" },
  86: { weather: "大阵雪", icon: "❄️", level: "danger", suggestion: "强阵雪，减少户外活动" },
  95: { weather: "雷暴", icon: "⛈️", level: "danger", suggestion: "雷暴天气，切勿在户外空旷处停留" },
  96: { weather: "雷暴伴冰雹", icon: "⛈️", level: "danger", suggestion: "雷暴冰雹，务必留在室内" },
  99: { weather: "强雷暴伴冰雹", icon: "⛈️", level: "danger", suggestion: "强雷暴冰雹，务必留在室内" },
};
const WMO_DEFAULT = { weather: "未知", icon: "🌡️", level: "good" as WeatherLevel, suggestion: "" };

/** 高德中文天气 → 等级 / 建议 */
function levelFromAmapWeather(w: string): { level: WeatherLevel; suggestion: string } {
  if (/雷|暴|雹/.test(w)) return { level: "danger", suggestion: "强对流天气，避免户外活动" };
  if (/大雪|暴雪/.test(w)) return { level: "danger", suggestion: "大雪，建议调整户外活动" };
  if (/雨/.test(w)) {
    if (/大|暴|豪/.test(w)) return { level: "danger", suggestion: "雨势较大，优先室内景点，注意积水" };
    return { level: "warning", suggestion: "有雨，建议带伞，备室内备选" };
  }
  if (/雪/.test(w)) return { level: "warning", suggestion: "有雪，注意保暖防滑" };
  if (/雾|霾|沙/.test(w)) return { level: "warning", suggestion: "能见度低，注意出行安全" };
  return { level: "good", suggestion: "天气不错，适合出行" };
}

function iconFromAmapWeather(w: string): string {
  if (/雷|暴/.test(w)) return "⛈️";
  if (/雪/.test(w)) return "❄️";
  if (/雨/.test(w)) return /大|暴/.test(w) ? "🌧️" : "🌦️";
  if (/雾|霾/.test(w)) return "🌫️";
  if (/多云/.test(w)) return "⛅";
  if (/阴/.test(w)) return "☁️";
  if (/晴/.test(w)) return "☀️";
  return "🌡️";
}

/** 高德 casts → 统一 WeatherDay[] */
function amapCastsToDays(casts: any[]): WeatherDay[] {
  return casts.map((c) => {
    const weather = c.dayweather || c.weather || "未知";
    const lv = levelFromAmapWeather(weather);
    const dayWind = c.daywind ? (c.daywind + (c.daypower ? ` ${c.daypower}级` : "")) : "";
    return {
      date: c.date,
      weekday: weekdayOf(c.date) || (c.week ? `周${["日","一","二","三","四","五","六"][Number(c.week)%7]}` : ""),
      weather,
      icon: iconFromAmapWeather(weather),
      temp_min: Number(c.nighttemp),
      temp_max: Number(c.daytemp),
      wind: dayWind,
      level: lv.level,
      suggestion: lv.suggestion,
    };
  });
}

/** 日期字符串加 n 天（本地时区，避免 toISOString 的 UTC 偏移） */
function addDaysStr(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** km/h → 蒲福风力等级（统一高德「X 级」与 Open-Meteo「km/h」两种格式） */
function kmhToBeaufort(kmh: number): number {
  const thresholds = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
  let level = 0;
  for (const t of thresholds) if (kmh >= t) level += 1;
  return level;
}

/** 把 Open-Meteo 的 km/h 风速转成「3 级（16 km/h）」统一文本，避免前端把 km/h 误当级数 */
function windspeedText(raw: unknown): string {
  if (raw == null || raw === "") return "";
  const kmh = Math.round(Number(raw));
  if (!Number.isFinite(kmh)) return "";
  return `${kmhToBeaufort(kmh)} 级（${kmh} km/h）`;
}

/** Open-Meteo 预报 → 统一 WeatherDay[] */
async function openMeteoDays(
  lat: number,
  lng: number,
  n: number,
  start?: string,
): Promise<WeatherDay[]> {
  const range = start
    ? `&start_date=${start}&end_date=${addDaysStr(start, n - 1)}`
    : `&forecast_days=${n}`;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&daily=weathercode,temperature_2m_max,temperature_2m_min,windspeed_10m_max` +
    `&timezone=auto${range}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`open-meteo HTTP ${resp.status}`);
  const j: any = await resp.json();
  const daily = j?.daily;
  if (!daily?.time?.length) throw new Error("open-meteo 无数据");
  return daily.time.map((t: string, i: number) => {
    const code = Number(daily.weathercode?.[i]);
    const meta = WMO[code] || WMO_DEFAULT;
    return {
      date: t,
      weekday: weekdayOf(t),
      weather: meta.weather,
      icon: meta.icon,
      temp_min: Math.round(Number(daily.temperature_2m_min?.[i])),
      temp_max: Math.round(Number(daily.temperature_2m_max?.[i])),
      wind: windspeedText(daily.windspeed_10m_max?.[i]),
      level: meta.level,
      suggestion: meta.suggestion,
    };
  });
}

/**
 * 天气预报进程内缓存：日期切换/来回调整时直接命中，避免重复打上游。
 * key = city|from|days，10 分钟内复用。
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; fc: WeatherForecast | null }>();

/** 本地时区的今天（YYYY-MM-DD） */
function localDateStr(d = new Date()): string {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 获取城市从 start 起 N 天的天气预报（带缓存）。
 * 高德优先（国内准，仅覆盖今天起约 4 天），超出范围降级 Open-Meteo（免费无 key，支持未来 16 天），
 * 全部失败返回 null。
 */
export async function fetchWeather(
  city: string,
  days: number,
  start?: string,
): Promise<WeatherForecast | null> {
  const n = Math.max(1, Math.min(15, Math.floor(days) || 1));
  const from = /^\d{4}-\d{2}-\d{2}$/.test(start || "") ? start : undefined;
  const key = `${city}|${from || ""}|${n}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.fc;

  const fc = await fetchWeatherUncached(city, n, from);
  cache.set(key, { at: Date.now(), fc });
  if (cache.size > 300) cache.clear();
  return fc;
}

async function fetchWeatherUncached(
  city: string,
  n: number,
  from?: string,
): Promise<WeatherForecast | null> {
  const today = localDateStr();
  const rangeStart = from || today;
  const rangeEnd = addDaysStr(rangeStart, n - 1);
  // 高德仅覆盖今天起约 4 天；Open-Meteo 覆盖未来 16 天。
  // 超出覆盖范围直接跳过对应上游，避免"必失败还要等一轮超时"的延迟。
  const canUseAmap = rangeEnd <= addDaysStr(today, 3);
  const canUseMeteo = rangeStart <= addDaysStr(today, 15);

  // 1) 高德：仅当能完整覆盖请求区间时才直接使用
  let amapList: WeatherDay[] = [];
  if (canUseAmap) {
    try {
      const j = await amapWeather(city);
      const casts = j?.forecasts?.[0]?.casts;
      if (Array.isArray(casts) && casts.length) {
        amapList = amapCastsToDays(casts).filter((d) => d.date >= rangeStart);
        const last = amapList[amapList.length - 1]?.date || "";
        if (amapList.length >= n && last >= rangeEnd) {
          return {
            city,
            source: "amap",
            updated_at: new Date().toISOString(),
            forecast: amapList.slice(0, n),
          };
        }
      }
    } catch {
      /* 降级 */
    }
  }

  // 2) Open-Meteo：支持指定日期区间的完整天数（优先保证区间完整）
  if (canUseMeteo) {
    try {
      const pois = load_pois(city);
      if (pois.length) {
        const { lat, lng } = pois[0] as any;
        const forecast = await openMeteoDays(lat, lng, n, from);
        if (forecast.length) {
          return {
            city,
            source: "open-meteo",
            updated_at: new Date().toISOString(),
            forecast,
          };
        }
      }
    } catch {
      /* 降级 */
    }
  }

  // 3) 高德部分数据兜底
  if (amapList.length) {
    return {
      city,
      source: "amap",
      updated_at: new Date().toISOString(),
      forecast: amapList.slice(0, n),
    };
  }

  // 4) 开发环境示例数据：未配置 AMAP_KEY 且无外网时用于演示 UI（前端标注「示例数据」）。
  //    生产环境（NODE_ENV=production）严格返回 null，不展示虚假天气。
  if (process.env.NODE_ENV !== "production") {
    return {
      city,
      source: "demo",
      updated_at: new Date().toISOString(),
      forecast: devMockForecast(city, n, from),
    };
  }

  return null;
}

/** 开发环境示例预报：按出发月份给出合理的季节温度 + 轮转天气词（确定性，不跳变） */
function devMockForecast(city: string, n: number, start?: string): WeatherDay[] {
  const baseDate = start ? new Date(`${start}T00:00:00`) : new Date();
  const month = baseDate.getMonth() + 1;
  const base =
    month <= 2 || month >= 12
      ? { min: -2, max: 6 } // 冬
      : month <= 5
        ? { min: 11, max: 21 } // 春
        : month <= 8
          ? { min: 25, max: 34 } // 夏
          : { min: 15, max: 24 }; // 秋
  const pool = ["晴", "多云", "阴", "小雨", "晴", "多云", "阵雨"];
  const winds = ["东北风 3级", "东风 2级", "微风", "南风 3级"];
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(baseDate);
    d.setDate(baseDate.getDate() + i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const weather = pool[(i + month) % pool.length];
    const lv = levelFromAmapWeather(weather);
    const swing = (i % 3) - 1; // -1 / 0 / 1 确定性小幅波动
    return {
      date: dateStr,
      weekday: weekdayOf(dateStr),
      weather,
      icon: iconFromAmapWeather(weather),
      temp_min: base.min + swing,
      temp_max: base.max + swing,
      wind: winds[i % winds.length],
      level: lv.level,
      suggestion: lv.suggestion,
    };
  });
}

/** 把预报压缩成一段自然语言，喂给 AI 让其在规划时考虑天气 */
export function summarizeForecast(fc: WeatherForecast | null): string {
  if (!fc || !fc.forecast.length) return "";
  const lines = fc.forecast.map((d) => `${d.date} ${d.weekday} ${d.weather} ${d.temp_min}~${d.temp_max}℃`);
  return `出行期间天气预报（${fc.city}）：${lines.join("；")}。请据此合理安排室内外景点，雨雪天优先室内。`;
}
