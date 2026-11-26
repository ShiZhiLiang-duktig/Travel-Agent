/**
 * 前端 API 层：与后端 travel-agent-pi server 交互。
 * - GET /api/models  可用模型列表（多模型切换）
 * - GET /api/cities  支持的城市
 * - POST /api/run    SSE 流式获取规划工作流事件
 *
 * 注意：浏览器原生 EventSource 不支持 POST，这里用 fetch + ReadableStream 手动解析 SSE。
 */
import { authHeaders } from "./auth";

/** 后端推送的单条 SSE 事件 */
export interface StreamEvent {
  event: string;
  ts: string;
  agent?: string;
  detail?: any;
  [key: string]: any;
}

/** 模型选项（/api/models 返回） */
export interface ModelOption {
  key: string;
  label: string;
  group: "domestic" | "international";
  configured: boolean;
  note?: string;
}

/** 行程项（来自 itinerary.to_dict()） */
export interface ItineraryItemView {
  day: number;
  start: string;
  end: string;
  poi: string;
  city: string;
  walking_min: number;
  stairs: number;
  indoor: string;
  cost: number;
  is_backup: boolean;
  source: string;
}

export interface ItineraryView {
  label: string;
  days: number;
  total_cost: number;
  items: ItineraryItemView[];
}

/** 最终指标（metrics 事件） */
export interface MetricsView {
  constraint_pass_rate: number;
  hallucination_rate: number;
  resilience_score: number;
  total_cost: number;
  item_count: number;
  fragile_points: { disruption: string; reason: string }[];
}

/** 个人信息（昵称 / 所属城市 / 简介） */
export interface UserProfile {
  id: number;
  username: string;
  role: "user" | "admin";
  created_at: string;
  nickname: string;
  city: string;
  bio: string;
}

export async function fetchProfile(): Promise<UserProfile> {
  const r = await apiFetch(`${BASE}/api/profile`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `读取个人信息失败（${r.status}）`);
  return j as UserProfile;
}

export async function saveProfile(
  patch: Pick<UserProfile, "nickname" | "city" | "bio">,
): Promise<UserProfile> {
  const r = await apiFetch(`${BASE}/api/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `保存个人信息失败（${r.status}）`);
  return j as UserProfile;
}

/** 省级行政区列表（高德线上数据） */
export async function fetchProvinces(): Promise<string[]> {
  const r = await apiFetch(`${BASE}/api/amap/provinces`);
  const j = await r.json().catch(() => ({}));
  return (j.provinces as string[]) || [];
}

/** 运行参数 */
export type TravelPace = "relaxed" | "moderate" | "tight";

export interface RunParams {
  city: string;
  days: number;
  simulate_disruption?: string;
  modelKey?: string;
  /** 用户自然语言需求（真实模型模式下作为 prompt；faux 模式忽略） */
  requirement?: string;
  /** 数据源：local=内置快照演示；online=高德在线数据 */
  source?: DataSource;
  /** 结构化偏好：后端会转换为求解器硬约束，不再只依赖 prompt。 */
  group?: string[];
  pace?: TravelPace;
  afternoon_indoor?: boolean;
  must_have_lunch?: boolean;
  must_visit?: string[];
  avoid?: string[];
  transport_mode?: TransportMode;
  budget?: number;
}

/** 数据源：内置快照（项目演示） / 高德在线 */
export type DataSource = "local" | "online";

/** POI 快照（/api/pois 返回），用于把行程项名称匹配到经纬度 */
export interface PoiSnapshot {
  id: string;
  name: string;
  city: string;
  category: string;
  lat: number;
  lng: number;
  indoor?: string;
  /** 高德 POI 首图（无则不展示封面） */
  photo?: string;
  /** 高德评分（无则不展示） */
  rating?: string;
  [key: string]: any;
}

/** 地图打点用的行程点（已补齐经纬度） */
export interface MapPoint {
  key: string;
  name: string;
  day: number;
  start: string;
  end: string;
  lat?: number;
  lng?: number;
  indoor?: string;
  walking_min?: number;
}

/** 手动路线中的一个停靠点（用户从 POI 列表选入） */
export interface ManualStop {
  id: string; // POI id
  name: string;
  day: number;
  order: number; // 当天内顺序
  lat: number;
  lng: number;
  city?: string; // 所属城市（跨城市行程时区分）
  category?: string;
  indoor?: string;
  walking_minutes?: number;
  stairs?: number;
  cost?: number;
  visit_minutes?: number;
}

/** 旅行偏好（AI 规划视图用，会拼入 requirement 喂给模型） */
export interface TravelPreferences {
  budget?: number;
  group: string[];
  pace: TravelPace;
  /** 城际交通方式（飞机 / 高铁 / 自驾）；不选时按距离自动推荐 */
  transport_mode?: TransportMode;
  afternoon_indoor: boolean;
  must_have_lunch: boolean;
  must_visit: string[]; // POI 名称
  avoid: string[];
}

export const defaultPreferences: TravelPreferences = {
  // 出行人群默认选中「青年」：覆盖多数使用场景，用户可再增减
  group: ["青年"],
  // 行程节奏默认「适中」：不松不赶，作为最常见的起点
  pace: "moderate",
  // 两个日程开关默认关闭，需要时用户自己打开
  afternoon_indoor: false,
  must_have_lunch: false,
  must_visit: [],
  avoid: [],
};

const BASE = ""; // 走 Rsbuild dev proxy /api → :8787；生产同域

/** 统一请求封装：自动注入 Authorization 头（登录后所有接口都带 token） */
function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, headers: { ...(init?.headers || {}), ...authHeaders() } });
}

export async function fetchModels(): Promise<ModelOption[]> {
  const r = await apiFetch(`${BASE}/api/models`);
  const j = await r.json();
  return j.models as ModelOption[];
}

export async function fetchCities(source: DataSource = "local"): Promise<string[]> {
  const r = await fetch(`${BASE}/api/cities?source=${source}`);
  const j = await r.json();
  return j.cities as string[];
}

/**
 * 发起一次规划，SSE 流式回调 onEvent。
 * 返回的 Promise 在流结束后 resolve。
 */
export async function runStream(
  params: RunParams,
  onEvent: (e: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await apiFetch(`${BASE}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal,
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`请求失败：HTTP ${resp.status}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flush = () => {
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) {
          const raw = line.slice(6).trim();
          if (!raw) continue;
          try {
            onEvent(JSON.parse(raw) as StreamEvent);
          } catch {
            // 忽略非 JSON 行（如心跳注释）
          }
        }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    flush();
  }
  // 收尾：处理缓冲里可能残留的最后一帧
  flush();
}

// ── POI 快照（用于把行程项名称匹配到经纬度，地图打点） ──
export async function fetchPois(
  city: string,
  source: DataSource = "local",
): Promise<PoiSnapshot[]> {
  const r = await apiFetch(
    `${BASE}/api/pois?city=${encodeURIComponent(city)}&source=${source}`,
  );
  const j = await r.json();
  return (j.pois as PoiSnapshot[]) || [];
}

/** 地图内 POI 搜索：返回与 /api/pois 相同结构（含营业时间 / 人均 / 地址） */
export async function searchPois(
  q: string,
  city: string,
  source: DataSource = "local",
): Promise<PoiSnapshot[]> {
  const params = new URLSearchParams({ q, city, source });
  const r = await apiFetch(`${BASE}/api/poi/search?${params.toString()}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `搜索失败（${r.status}）`);
  return (j.pois as PoiSnapshot[]) || [];
}

// ── 高德地图（查询走后端代理，避免前端 Key 暴露） ──
export async function fetchAmapConfig(): Promise<{ enabled: boolean }> {
  const r = await apiFetch(`${BASE}/api/amap/config`);
  return r.json();
}

/** 地点搜索（后端代理高德 /v3/place/text） */
export async function fetchAmapPlace(keywords: string, city?: string): Promise<any> {
  const q = new URLSearchParams({ keywords });
  if (city) q.set("city", city);
  const r = await apiFetch(`${BASE}/api/amap/place?${q.toString()}`);
  return r.json();
}

/** 高德地点详情摘要（前端展示用，已做容错归一化） */
export interface AmapPoiBrief {
  name: string;
  address: string;
  /** 内部归一分类：只推荐 category === "景点" 的地点 */
  category?: string;
  /** 评分（无则空串） */
  rating: string;
  /** 人均消费（元，无则空串） */
  cost: string;
  /** 营业时间 */
  openTime: string;
  /** 首张缩略图 URL（无则不渲染图） */
  photo: string;
}

/**
 * 地点搜索并归一化：把高德原始 poi 转成带图片 / 评分 / 营业时间的摘要，
 * 供「必去景点」候选卡片展示。
 */
export async function fetchAmapPoiBriefs(
  keywords: string,
  city?: string,
): Promise<AmapPoiBrief[]> {
  const j = await fetchAmapPlace(keywords, city);
  const raw = Array.isArray(j?.pois) ? j.pois : [];
  const seen = new Set<string>();
  const out: AmapPoiBrief[] = [];
  for (const p of raw) {
    const name = String(p?.name || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const biz = p?.biz_ext || {};
    const type = String(p?.type || "");
    const category = /住宿|酒店|宾馆|民宿/.test(type)
      ? "酒店"
      : /美食|餐饮|餐厅|小吃|咖啡|酒吧/.test(type)
        ? "餐厅"
        : /购物|商场|超市|市场|商业街|百货/.test(type)
          ? "购物"
          : "景点";
    out.push({
      name,
      address: String(p?.address || ""),
      category,
      rating: String(biz.rating || ""),
      cost: String(biz.cost || ""),
      openTime: String(biz.opentime2 || biz.opentime || ""),
      photo: String(p?.photos?.[0]?.url || ""),
    });
  }
  return out;
}

/** 高德输入提示结果（城市 / 地点联想） */
export interface AmapTip {
  name: string;
  district: string;
  adcode: string;
  location: string;
}

/** 城市联想（后端代理高德 inputtips，支持国内任意城市） */
export async function fetchAmapCity(q: string): Promise<AmapTip[]> {
  const r = await apiFetch(`${BASE}/api/amap/city?q=${encodeURIComponent(q)}`);
  const j = await r.json();
  return (j.tips as AmapTip[]) || [];
}

/**
 * 路径规划（后端代理高德 /v3/direction/{walking|driving}）
 * origin / destination："lng,lat"（经度在前）
 */
export async function fetchAmapRoute(
  origin: string,
  destination: string,
  type: "walking" | "driving" = "walking",
): Promise<any> {
  const q = new URLSearchParams({ origin, destination, type });
  const r = await apiFetch(`${BASE}/api/amap/route?${q.toString()}`);
  return r.json();
}

/** 地理编码：地名 → 经纬度（后端代理高德 /v3/geocode/geo） */
export async function fetchAmapGeocode(address: string, city?: string): Promise<any> {
  const q = new URLSearchParams({ address });
  if (city) q.set("city", city);
  const r = await apiFetch(`${BASE}/api/amap/geocode?${q.toString()}`);
  return r.json();
}

/** 搜索框回车定位：城市 / 省份 / 景点 → 视野中心 + 建议缩放 */
export interface LocateResult {
  found: boolean;
  kind?: "province" | "city" | "district" | "poi";
  name?: string;
  center?: string;
  zoom?: number;
  /** 定位后地图搜索的作用域城市（行政区 / 具体地点所在城市的简称） */
  scope?: string;
  error?: string;
}
export async function fetchAmapLocate(q: string): Promise<LocateResult> {
  const r = await apiFetch(`${BASE}/api/amap/locate?q=${encodeURIComponent(q)}`);
  return r.json();
}

// ── 城际交通：出发城市 → 目的地，飞机 / 高铁 / 自驾推荐 ──
export type TransportMode = "plane" | "train" | "drive";

export interface DriveCostBreakdown {
  km: number;
  highway_km: number;
  /** 燃油费（元，整车） */
  fuel: number;
  /** 高速通行费（元，整车） */
  toll: number;
  /** 整车合计（元） */
  total: number;
  travelers: number;
  /** 人均（元） */
  per_person: number;
  basis: string;
}

export interface TransportOption {
  mode: TransportMode;
  label: string;
  /** 全程预计小时数（含候车 / 值机） */
  hours: number;
  /** 单人预计费用（元） */
  cost: number;
  note: string;
  /** 自驾才有：油费 / 过路费拆分 */
  cost_breakdown?: DriveCostBreakdown;
}

/** 班次/余票状态 */
export type AvailabilityStatus =
  | "available"
  | "limited"
  | "sold_out"
  | "not_required"
  | "unavailable";

export interface AvailabilityEntry {
  label: string;
  depart: string;
  arrive: string;
  duration_min?: number;
  price?: number;
  seat: string;
  status: string;
  /** 补充信息（机场 / 机型 / 准点率等） */
  sub?: string;
}

export interface ModeAvailability {
  mode: TransportMode;
  status: AvailabilityStatus;
  headline: string;
  detail: string;
  source: string;
  checked_at: string;
  entries?: AvailabilityEntry[];
}

export interface TransportPlan {
  from: string;
  to: string;
  distance_km: number;
  recommended: TransportMode;
  options: TransportOption[];
  summary: string;
  /** 三种方式各自的班次/余票查询结果 */
  availability: Record<TransportMode, ModeAvailability>;
  /** 12306 实时车次（后端配置 MCP 且查到数据时返回） */
  realtime?: {
    source: "12306";
    date: string;
    /** 实际查询城市（省级出发地会代查省会） */
    query_from: string;
    query_to: string;
    trains: {
      code: string;
      from_station: string;
      to_station: string;
      depart: string;
      arrive: string;
      duration_min: number;
      second_price?: number;
      second_status?: string;
    }[];
  };
}

export async function fetchTransport(
  from: string,
  to: string,
  date?: string,
  travelers?: number,
): Promise<TransportPlan> {
  const q = new URLSearchParams({ from, to });
  if (date) q.set("date", date);
  if (travelers && travelers > 0) q.set("travelers", String(travelers));
  const r = await apiFetch(`${BASE}/api/transport?${q.toString()}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.options) throw new Error(j?.error || `交通规划失败（${r.status}）`);
  return j as TransportPlan;
}

/** 往返交通段：前端按所选交通方式生成，写入行程首尾两天 */
export interface IntercityLeg {
  mode: TransportMode;
  label: string;
  from: string;
  to: string;
  hours: number;
  cost: number;
  day: number;
}

export interface IntercityLegs {
  outbound: IntercityLeg;
  inbound: IntercityLeg;
}

// ── 只读分享（生成链接需登录，查看无需登录） ──
/** 分享出去的一份行程快照 */
export interface SharedTrip {
  slug: string;
  title: string;
  city: string;
  days: number;
  startDate: string;
  itinerary: ItineraryView;
  created_at?: string;
}

/** 创建分享链接，返回 slug（前端自行拼 #/s/<slug>） */
export async function createShare(input: {
  itinerary: ItineraryView;
  city: string;
  days: number;
  startDate?: string;
  title?: string;
}): Promise<{ slug: string }> {
  const r = await apiFetch(`${BASE}/api/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.slug) throw new Error(j?.error || `分享失败（${r.status}）`);
  return { slug: j.slug as string };
}

/** 读取公开分享（无需 token） */
export async function fetchShare(slug: string): Promise<SharedTrip> {
  const r = await fetch(`${BASE}/api/share/${encodeURIComponent(slug)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.itinerary) throw new Error(j?.error || `分享不存在（${r.status}）`);
  return j as SharedTrip;
}

// ── 出行天气预报（高德优先 → Open-Meteo 降级；失败返回 null，前端不渲染） ──
export type WeatherLevel = "good" | "warning" | "danger";

export interface WeatherDay {
  date: string; // YYYY-MM-DD
  weekday: string;
  weather: string;
  icon: string;
  temp_min: number;
  temp_max: number;
  wind: string;
  level: WeatherLevel;
  suggestion: string;
}

export interface WeatherForecast {
  city: string;
  source: "amap" | "open-meteo" | "demo";
  updated_at: string;
  forecast: WeatherDay[];
}

/** 天气前端缓存：同一城市 + 区间 5 分钟内直接复用，日期来回调整时无需再等网络 */
const weatherCache = new Map<string, { at: number; data: WeatherForecast | null }>();
const WEATHER_TTL_MS = 5 * 60 * 1000;

export async function fetchWeather(
  city: string,
  days: number,
  start?: string,
  signal?: AbortSignal,
): Promise<WeatherForecast | null> {
  const key = `${city}|${days}|${start || ""}`;
  const hit = weatherCache.get(key);
  if (hit && Date.now() - hit.at < WEATHER_TTL_MS) return hit.data;
  try {
    const q =
      `city=${encodeURIComponent(city)}&days=${days}` +
      (start ? `&start=${encodeURIComponent(start)}` : "");
    const r = await apiFetch(`${BASE}/api/weather?${q}`, { signal });
    const j = await r.json();
    const data = (j.forecast as WeatherForecast) || null;
    weatherCache.set(key, { at: Date.now(), data });
    if (weatherCache.size > 200) weatherCache.clear();
    return data;
  } catch {
    return null;
  }
}
