/**
 * 高德地图 Web 服务 API 代理层。
 *
 * 分层架构（经验沉淀）：前端只负责地图渲染与交互（JS API），
 * POI 搜索 / 路径规划 / 地理编码等查询能力统一走后端代理高德 Web 服务 REST API，
 * 避免前端 Key 暴露、跨域与 Referer 校验问题。
 *
 * Key 仅存在于服务端环境变量 process.env.AMAP_KEY，绝不回传给前端。
 * 未配置时返回 503 + 友好提示，前端据此降级为「示意图」打点。
 */
const AMAP_REST = "https://restapi.amap.com";

/** 读取高德 Web 服务 Key（服务端专用） */
function amapKey(): string {
  return (process.env.AMAP_KEY || "").trim();
}

export function isAmapConfigured(): boolean {
  return !!amapKey();
}

class AmapError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** 高德个人 Key 的 QPS 很低（约 3 次/秒），命中限流时抛出 CUQPS_HAS_EXCEEDED_THE_LIMIT */
function isRateLimited(err: unknown): boolean {
  const msg = String((err as any)?.message || err);
  return /CUQPS|QPS|LIMIT/i.test(msg);
}

/**
 * 全局串行队列：所有高德 REST 请求逐条发出，避免并发触发 QPS 限流。
 * 单次请求约 200ms，串行对交互影响可接受。
 */
let amapQueue: Promise<unknown> = Promise.resolve();
function serialAmap<T>(fn: () => Promise<T>): Promise<T> {
  const run = amapQueue.then(fn, fn);
  amapQueue = run.catch(() => undefined);
  return run;
}

/** 实际发起一次高德请求并解析（不含排队） */
async function amapGetOnce(url: string): Promise<any> {
  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (err: any) {
    throw new AmapError("AMAP_NETWORK", `高德接口请求失败：${err?.message || err}`);
  }
  if (!resp.ok) {
    throw new AmapError("AMAP_HTTP", `高德接口 HTTP ${resp.status}`);
  }
  let j: any;
  try {
    j = await resp.json();
  } catch {
    throw new AmapError("AMAP_PARSE", "高德接口返回非 JSON");
  }
  if (j.status !== "1") {
    throw new AmapError(
      "AMAP_API",
      `高德接口返回异常：${j.info || "未知错误"}（status=${j.status}）`,
    );
  }
  return j;
}

/** 统一 GET 高德 REST 接口；自动附带 key，未配置则抛 AMAP_NOT_CONFIGURED。所有请求全局串行。 */
async function amapGet(
  path: string,
  params: Record<string, string>,
): Promise<any> {
  const key = amapKey();
  if (!key) {
    throw new AmapError(
      "AMAP_NOT_CONFIGURED",
      "未配置 AMAP_KEY，高德地图 Web 服务不可用（在 .env 中填入后重启服务）",
    );
  }
  const qs = new URLSearchParams({ ...params, key }).toString();
  const url = `${AMAP_REST}${path}?${qs}`;
  return serialAmap(() => amapGetOnce(url));
}

/** 地点文本搜索：GET /v3/place/text（extensions=all 带出图片/评分/营业时间等详情） */
export async function amapPlaceText(
  keywords: string,
  city?: string,
  page = 1,
  offset = 25,
): Promise<any> {
  return amapGet("/v3/place/text", {
    keywords,
    city: city || "",
    // 有城市上下文时限定市内，避免全国结果挤掉本地 POI
    citylimit: city ? "true" : "false",
    offset: String(offset),
    page: String(page),
    extensions: "all",
  });
}

/** 输入提示（城市/地点联想）：GET /v3/assistant/inputtips */
export async function amapInputTips(
  keywords: string,
  city?: string,
): Promise<any> {
  return amapGet("/v3/assistant/inputtips", {
    keywords,
    city: city || "",
    citylimit: "false",
  });
}

/** 行政区查询（城市联想/规范化）：GET /v3/config/district，subdistrict=1 时带下级行政区 */
export async function amapDistrict(keywords: string, subdistrict = "0"): Promise<any> {
  return amapGet("/v3/config/district", {
    keywords,
    subdistrict,
    extensions: "base",
  });
}

/** 省级行政区列表缓存（行政边界几乎不变，缓存 24 小时） */
let provinceCache: { at: number; list: string[] } | null = null;

/** 去掉行政区后缀：北京市→北京、江苏省→江苏、内蒙古自治区→内蒙古 */
function shortProvinceName(name: string): string {
  return String(name)
    .replace(/特别行政区$/, "")
    .replace(/(壮族|维吾尔|回族)?自治区$/, "")
    .replace(/[省市]$/, "");
}

/**
 * 省级行政区列表：GET /v3/config/district?keywords=中国&subdistrict=1
 * 直辖市（北京市/上海市/天津市/重庆市）本身即省级，保留原名。
 */
export async function amapProvinces(): Promise<string[]> {
  if (provinceCache && Date.now() - provinceCache.at < 24 * 3600 * 1000) {
    return provinceCache.list;
  }
  const j = await amapGet("/v3/config/district", {
    keywords: "中国",
    subdistrict: "1",
    extensions: "base",
  });
  const list = ((j?.districts?.[0]?.districts || []) as any[])
    .map((d) => shortProvinceName(d?.name || ""))
    .filter(Boolean);
  provinceCache = { at: Date.now(), list };
  return list;
}

/** 带限流重试的地点搜索（最多 3 次，退避 300/600ms） */
async function placeTextWithRetry(
  keywords: string,
  city?: string,
  page = 1,
  offset = 25,
): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await amapPlaceText(keywords, city, page, offset);
    } catch (err) {
      lastErr = err;
      if (!isRateLimited(err) || i === 2) throw err;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * 关键词全量分页拉取：高德 place/text 单页最多 25 条，按页顺序取到结果不足或达到上限。
 * 所有请求经 serialAmap 串行，不会突破个人 Key 的 QPS；单页失败不影响其它页。
 */
export async function amapPlaceTextAll(
  keywords: string,
  city?: string,
  maxPages = 4,
): Promise<any[]> {
  const out: any[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    let j: any;
    try {
      j = await placeTextWithRetry(keywords, city, page, 25);
    } catch {
      break;
    }
    const pois = (Array.isArray(j?.pois) ? j.pois : []) as any[];
    for (const p of pois) {
      if (!p?.id || seen.has(String(p.id))) continue;
      seen.add(String(p.id));
      out.push(p);
    }
    // 高德在最后一页会返回 count 累计值；本页不足一页即认为已取完
    if (pois.length < 25) break;
  }
  return out;
}

/**
 * 城市 POI 全量拉取：多组关键词覆盖景点 / 博物馆 / 公园 / 古镇 / 寺院 / 餐饮 / 住宿 /
 * 购物 / 机场 / 车站，每组按页取满（不再只取每组前 10 条）。单组失败不影响其它组。
 */
export async function amapCityPoisRaw(city: string): Promise<any[]> {
  const kws = [
    "景点", "风景区", "博物馆", "公园", "古镇", "寺庙",
    "美术馆", "动物园", "植物园", "餐厅", "酒店", "购物", "机场", "火车站",
  ];
  const groups: any[][] = [];
  for (const kw of kws) {
    groups.push(await amapPlaceTextAll(kw, city, 3));
  }
  const seen = new Set<string>();
  const out: any[] = [];
  for (const group of groups) {
    for (const p of group) {
      if (!p?.id || seen.has(String(p.id))) continue;
      seen.add(String(p.id));
      out.push(p);
    }
  }
  return out;
}

/** 地理编码：地名 → 经纬度 GET /v3/geocode/geo */
export async function amapGeocode(
  address: string,
  city?: string,
): Promise<any> {
  return amapGet("/v3/geocode/geo", { address, city: city || "" });
}

/* ───────────────────────── 搜索框回车定位 ───────────────────────── */

/** 行政区名归一：广东省→广东、北京市→北京、内蒙古自治区→内蒙古 */
function normAdminName(name: string): string {
  return String(name || "")
    .replace(/特别行政区$/, "")
    .replace(/(壮族|维吾尔|回族)?自治区$/, "")
    .replace(/[省市县区]$/, "")
    .trim();
}

/** "lng,lat" → [lng, lat]，非法返回 null */
function parseLatLng(location: unknown): [number, number] | null {
  const parts = String(location || "").split(",");
  if (parts.length !== 2) return null;
  const lng = Number(parts[0]);
  const lat = Number(parts[1]);
  return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
}

export interface LocateResult {
  kind: "province" | "city" | "district" | "poi";
  /** 展示用名称（广东省 / 天坛公园） */
  name: string;
  /** 视野中心 "lng,lat" */
  center: string;
  /** 建议缩放级别 */
  zoom: number;
  /**
   * 定位后地图搜索的城市作用域：行政区取简称（广东 / 天津）；
   * 具体地点取高德返回的城市名简称（故宫 → 北京），供分类高亮搜索使用。
   */
  scope?: string;
}

/**
 * 地名 → 地图视野：搜索框按回车时调用。
 *
 * 三级判定，先行政区后 POI：
 *   1. 行政区精确匹配（广东→广东省、天津→天津市、朝阳→朝阳区）——模糊匹配不带入，避免「天津之眼」被当成天津市；
 *   2. 高德地点搜索首个结果（天坛公园、天津之眼这类具体地点）；
 *   3. 地理编码兜底（路名、门牌号）。
 *
 * 高德个人 Key QPS 很低，每次调用都可能命中限流，统一走 3 次退避重试。
 */
export async function amapLocate(keyword: string): Promise<LocateResult | null> {
  const q = String(keyword || "").trim();
  if (!q) return null;
  const wanted = normAdminName(q);

  const withRetry = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    for (let i = 0; i < 3; i++) {
      try {
        return await fn();
      } catch (err) {
        if (!isRateLimited(err) || i === 2) return null;
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
    return null;
  };

  // 1) 行政区精确匹配
  const dj = await withRetry(() => amapDistrict(q, "1"));
  const d = (dj?.districts || [])[0];
  if (d?.name && normAdminName(d.name) === wanted) {
    const level = String(d.level || "");
    const short = normAdminName(d.name);
    // 省级中心的 center 个别情况下为空 → 退回首个下辖市的中心
    const center =
      parseLatLng(d.center) !== null
        ? String(d.center)
        : String((((d.districts || []) as any[]).find((x) => parseLatLng(x?.center)) || {}).center || "");
    if (parseLatLng(center)) {
      const municipality = ["北京", "上海", "天津", "重庆"].includes(short);
      if (level === "province" && !municipality) {
        return { kind: "province", name: d.name, center, zoom: 7, scope: short };
      }
      if (level === "province" || level === "city") {
        return { kind: "city", name: d.name, center, zoom: 10, scope: short };
      }
      if (level === "district") {
        return { kind: "district", name: d.name, center, zoom: 12, scope: short };
      }
    }
  }

  // 2) 地点搜索：景点 / 商场 / 车站等具体地点
  const pj = await withRetry(() => amapPlaceText(q));
  const po = (pj?.pois || [])[0];
  if (po?.location && parseLatLng(po.location)) {
    // 具体地点也要带出城市：分类高亮需要 city 上下文，否则会退化成全国搜索
    const scope = normAdminName(String(po.cityname || po.pname || ""));
    return {
      kind: "poi",
      name: String(po.name || q),
      center: String(po.location),
      zoom: 14,
      ...(scope ? { scope } : {}),
    };
  }

  // 3) 地理编码兜底
  const gj = await withRetry(() => amapGeocode(q));
  const geo = (gj?.geocodes || [])[0];
  if (geo?.location && parseLatLng(geo.location)) {
    const level = String(geo.level || "");
    const zoom = /省/.test(level) ? 7 : /市/.test(level) ? 10 : /区|县/.test(level) ? 12 : 15;
    const scope = normAdminName(String(geo.city || geo.province || ""));
    return {
      kind: "poi",
      name: String(geo.formatted_address || q),
      center: String(geo.location),
      zoom,
      ...(scope ? { scope } : {}),
    };
  }

  return null;
}

/**
 * 路径规划：GET /v3/direction/{walking|driving}
 * origin / destination 格式："lng,lat"（经度在前，纬度在后）
 */
export async function amapRoute(
  origin: string,
  destination: string,
  type: "walking" | "driving" = "walking",
): Promise<any> {
  return amapGet(`/v3/direction/${type}`, { origin, destination });
}

/**
 * 天气预报查询：GET /v3/weather/weatherInfo
 * city 支持城市中文名（如"苏州"）或 adcode；extensions=all 返回未来 4 天预报。
 * 原始 JSON 透传给上层归一化（forecasts[0].casts: [{date,week,dayweather,nightweather,daytemp,nighttemp,...}]）
 */
export async function amapWeather(city: string): Promise<any> {
  return amapGet("/v3/weather/weatherInfo", { city, extensions: "all" });
}
