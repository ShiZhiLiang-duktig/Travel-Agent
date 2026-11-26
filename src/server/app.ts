/**
 * Hono 应用 —— travel-agent-pi 的 HTTP + SSE 服务。
 *
 * 路由（公开 / 需登录 / 需管理员三组）：
 *   公开
 *     GET  /api/health              健康检查（DB / 语义后端 / 前端构建状态）
 *     GET  /api/models              可用模型列表（含是否已配置 Key）
 *     GET  /api/cities              支持规划的城市
 *     POST /api/auth/login          登录
 *     POST /api/auth/register       注册
 *     GET  /api/share/:slug         查看只读分享（无需登录）
 *   需登录（Bearer token）
 *     GET  /api/auth/me             当前用户
 *     POST /api/auth/logout         登出
 *     GET  /api/profile             读取个人信息（昵称 / 出发城市 / 简介）
 *     PUT  /api/profile             保存个人信息
 *     POST /api/share               创建只读分享链接
 *     GET  /api/pois?city=&source=  城市 POI（内置快照或高德在线全量）
 *     GET  /api/poi/search          地图内分类搜索（交通枢纽离线走全国内置表）
 *     GET  /api/transport           城际交通推荐（飞机 / 高铁 / 自驾，date 接 12306）
 *     GET  /api/flight/health       航班数据源自检
 *     GET  /api/weather             出行天气预报（高德 → Open-Meteo 降级）
 *     GET  /api/search?q=           语义检索 POI（PgVector 或本地文件后端）
 *     POST /api/run                 驱动 pi Agent Runtime，SSE 流式推送事件
 *     GET  /api/amap/config         高德是否已配置（不泄露 Key）
 *     GET  /api/amap/provinces      省级行政区列表
 *     GET  /api/amap/city           城市联想
 *     GET  /api/amap/place          高德地点搜索（后端代理）
 *     GET  /api/amap/route          高德路径规划（walking / driving）
 *     GET  /api/amap/locate         搜索框回车定位
 *     GET  /api/amap/geocode        高德地理编码
 *   需管理员
 *     GET    /api/admin/users       用户列表
 *     DELETE /api/admin/users/:id   删除用户
 *     GET    /api/admin/runs        运行记录
 *     GET    /api/runs              运行记录（同 /api/admin/runs）
 *   其它
 *     GET  /*                       托管前端构建产物 web/dist（SPA 回退，含 /s/:slug）
 *
 * SSE 协议保持兼容：每帧 `data: <json>\n\n`，json 含 event/ts/agent/detail。
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runAgentRuntime } from "./agent-runtime-run.js";
import {
  list_cities,
  load_pois,
  load_builtin_pois,
  has_city_snapshot,
  has_builtin_snapshot,
  register_city_pois,
  load_transport_pois,
} from "../data/snapshot.js";
import {
  MODEL_REGISTRY,
  listModelsForClient,
  getModelEntry,
  isModelConfigured,
  pickDefaultModel,
} from "./model-registry.js";
import {
  isDbReady,
  isSemanticReady,
  getDbStatus,
  searchPois,
  saveRun,
  recentRuns,
} from "./db.js";
import {
  isAmapConfigured,
  amapPlaceText,
  amapPlaceTextAll,
  amapInputTips,
  amapDistrict,
  amapProvinces,
  amapCityPoisRaw,
  amapRoute,
  amapGeocode,
  amapLocate,
} from "./amap.js";
import { fetchWeather } from "./weather.js";
import { planTransport } from "./transport.js";
import { checkFlightSource } from "./flight.js";
import {
  login,
  register,
  listAllUsers,
  deleteUserById,
  destroySession,
  requireAuth,
  requireAdmin,
  currentUser,
  getProfile,
  updateProfile,
} from "./auth.js";
import { saveShare, getShare } from "./shares.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 前端构建产物目录（生产托管用）
const WEB_DIST = path.resolve(__dirname, "../../web/dist");

const app = new Hono();

// 开发期前端跑在 Rsbuild dev server（经 proxy 调 /api），CORS 兜底
// 允许 Authorization 头：前端携带 Bearer token
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// ---------- 基础信息 ----------
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    service: "travel-agent-pi",
    runtime: "hono",
    db: getDbStatus(),
    frontendBuilt: fs.existsSync(path.join(WEB_DIST, "index.html")),
  }),
);

app.get("/api/models", (c) =>
  c.json({ models: listModelsForClient(), total: MODEL_REGISTRY.length }),
);

app.get("/api/cities", (c) => {
  // 线上模式先给一批热门城市做兜底候选，其余由高德城市搜索联想获取
  const online = c.req.query("source") === "online";
  return c.json({
    cities: online ? ONLINE_HOT_CITIES : list_cities(),
    source: online ? "online" : "local",
  });
});

/** 线上模式的热门城市默认候选（可随意搜索其它城市） */
const ONLINE_HOT_CITIES = [
  "北京", "上海", "广州", "深圳", "成都", "重庆", "西安", "杭州",
  "南京", "苏州", "武汉", "长沙", "厦门", "青岛", "大连", "昆明",
  "三亚", "丽江", "哈尔滨", "乌鲁木齐",
];

// ---------- 鉴权：登录 / 注册 / 当前用户 / 登出（公开） ----------
app.post("/api/auth/login", async (c) => {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求体不是合法 JSON" }, 400);
  }
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password) return c.json({ error: "用户名和密码不能为空" }, 400);
  const result = await login(username, password);
  if (!result) return c.json({ error: "用户名或密码错误" }, 401);
  return c.json({ token: result.token, user: result.user });
});

app.post("/api/auth/register", async (c) => {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求体不是合法 JSON" }, 400);
  }
  try {
    const user = await register(String(body.username || ""), String(body.password || ""));
    return c.json({ ok: true, user });
  } catch (err: any) {
    return c.json({ error: err?.message || String(err) }, 400);
  }
});

app.get("/api/auth/me", requireAuth(), (c) => c.json({ user: currentUser(c) }));

app.post("/api/auth/logout", requireAuth(), (c) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "").trim();
  destroySession(token);
  return c.json({ ok: true });
});

// ---------- 个人信息：昵称 / 所属城市 / 简介 ----------
app.get("/api/profile", requireAuth(), async (c) => {
  const u = currentUser(c)!;
  const profile = await getProfile(u.id);
  if (!profile) return c.json({ error: "用户不存在" }, 404);
  return c.json(profile);
});

app.put("/api/profile", requireAuth(), async (c) => {
  const u = currentUser(c)!;
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求体不是合法 JSON" }, 400);
  }
  try {
    return c.json(await updateProfile(u.id, body || {}));
  } catch (err: any) {
    return c.json({ error: err?.message || String(err) }, 400);
  }
});

// ---------- 角色守卫：数据/规划接口需登录；管理接口需管理员 ----------
app.use("/api/pois", requireAuth());
app.use("/api/poi/search", requireAuth());
app.use("/api/weather", requireAuth());
app.use("/api/transport", requireAuth());
// 航班数据源自检：握手 + tools/list，不查真实航班，用于配完立刻验证
app.use("/api/flight/health", requireAuth());
app.use("/api/search", requireAuth());
app.use("/api/run", requireAuth());
app.use("/api/amap/*", requireAuth());
app.use("/api/runs", requireAdmin());
app.use("/api/admin/*", requireAdmin());

// ---------- 只读分享：创建需登录，查看完全公开 ----------
app.post("/api/share", requireAuth(), async (c) => {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求体不是合法 JSON" }, 400);
  }
  const itinerary = body?.itinerary;
  if (!itinerary || !Array.isArray(itinerary.items) || itinerary.items.length === 0) {
    return c.json({ error: "行程为空，无法分享" }, 400);
  }
  if (JSON.stringify(itinerary).length > 512 * 1024) {
    return c.json({ error: "行程数据过大，无法分享" }, 413);
  }
  const payload = {
    title: typeof body.title === "string" ? body.title.slice(0, 80) : "",
    city: typeof body.city === "string" ? body.city.slice(0, 80) : "",
    days: Number(body.days) || Number(itinerary.days) || 0,
    startDate: typeof body.startDate === "string" ? body.startDate.slice(0, 20) : "",
    itinerary,
  };
  try {
    const rec = await saveShare(payload, currentUser(c)?.username || "anonymous");
    return c.json({
      ok: true,
      slug: rec.slug,
      path: `/s/${rec.slug}`,
      created_at: rec.created_at,
    });
  } catch (err: any) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

app.get("/api/share/:slug", async (c) => {
  const slug = (c.req.param("slug") || "").trim();
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(slug)) {
    return c.json({ error: "分享链接无效" }, 400);
  }
  const rec = await getShare(slug);
  if (!rec) return c.json({ error: "分享不存在或已失效" }, 404);
  return c.json({
    ok: true,
    slug: rec.slug,
    title: rec.payload.title,
    city: rec.payload.city,
    days: rec.payload.days,
    startDate: rec.payload.startDate,
    itinerary: rec.payload.itinerary,
    created_at: rec.created_at,
  });
});

// ---------- 管理后台：用户管理 ----------
app.get("/api/admin/users", async (c) => {
  const users = await listAllUsers();
  return c.json({ count: users.length, users });
});

app.delete("/api/admin/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const actor = currentUser(c);
  if (!Number.isFinite(id)) return c.json({ error: "无效的用户 id" }, 400);
  try {
    const ok = await deleteUserById(id, actor?.id ?? -1);
    return c.json({ ok });
  } catch (err: any) {
    return c.json({ error: err?.message || String(err) }, 400);
  }
});

// ---------- 管理后台：运行记录（已被 requireAdmin 守卫） ----------
app.get("/api/admin/runs", async (c) => {
  const limit = Number(c.req.query("limit")) || 20;
  try {
    const runs = await recentRuns(limit);
    return c.json({ dbReady: isDbReady(), count: runs.length, runs });
  } catch (err: any) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

app.get("/api/pois", async (c) => {
  const city = (c.req.query("city") || "苏州").trim();
  const source = c.req.query("source") === "local" ? "local" : "online";
  // 内置快照未覆盖的城市 → 用高德在线拉取景点/餐厅/酒店，写入运行时缓存后返回
  const requested = city.split(/[,，、\s]+/).filter(Boolean);
  if (source === "local") {
    // 本地演示模式：只用内置快照，不访问高德
    if (!requested.some((n: string) => has_builtin_snapshot(n))) {
      return c.json({ city, count: 0, pois: [], source, unavailable: true });
    }
    const builtin = load_builtin_pois(city);
    return c.json({ city, count: builtin.length, pois: builtin, source });
  }
  // 在线模式：即使城市有内置快照，也要拉高德全量数据（内置城市以前只有 10 个景点，不完整）
  const online = isAmapConfigured() ? await ensureOnlineCityPois(requested) : false;
  const pois = load_pois(city);
  // 全都没有可用数据时不回退苏州数据，避免把别的城市景点当成目标城市展示
  const unavailable = !requested.some((n: string) => has_city_snapshot(n));
  if (unavailable) {
    return c.json({ city, count: 0, pois: [], online, source, unavailable: true });
  }
  return c.json({ city, count: pois.length, pois, online, source });
});

// ---------- 城际交通：出发城市 → 目的地，推荐飞机 / 高铁 / 自驾 ----------
app.get("/api/transport", async (c) => {
  const from = (c.req.query("from") || "").trim();
  const to = (c.req.query("to") || "").trim();
  // 出行日期：用于查询 12306 实时车次（yyyy-MM-dd）
  const dateRaw = (c.req.query("date") || "").trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? dateRaw : undefined;
  // 同车人数：前端不再让用户选，默认按整车（1）计；保留参数供外部调用方按人数分摊
  const travelersRaw = Number((c.req.query("travelers") || "").trim());
  const travelers = Number.isFinite(travelersRaw) && travelersRaw >= 1 && travelersRaw <= 7
    ? Math.round(travelersRaw)
    : 1;
  if (!from || !to) return c.json({ error: "缺少出发城市或目的地城市" }, 400);
  if (!isAmapConfigured())
    return c.json({ error: "未配置 AMAP_KEY，暂时无法计算城际交通" }, 503);
  try {
    return c.json(await planTransport(from, to, date, travelers));
  } catch (err: any) {
    return c.json({ error: err?.message || String(err) }, 502);
  }
});

// ---------- 航班数据源自检（不返回 URL，只看能不能连上、有哪些工具） ----------
app.get("/api/flight/health", async (c) => {
  try {
    return c.json(await checkFlightSource());
  } catch (err: any) {
    return c.json({ configured: true, ok: false, error: err?.message || String(err) }, 502);
  }
});

// ---------- 高德地图代理（前端只渲染，查询走后端，避免 Key 暴露） ----------
app.get("/api/amap/config", (c) => c.json({ enabled: isAmapConfigured() }));

// 省级行政区列表（个人信息里的「所属省份」，线上取自高德，24h 缓存）
app.get("/api/amap/provinces", async (c) => {
  if (!isAmapConfigured())
    return c.json({ provinces: [], enabled: false, error: "未配置 AMAP_KEY，省份列表不可用" });
  try {
    return c.json({ provinces: await amapProvinces(), enabled: true });
  } catch (err: any) {
    return c.json({ provinces: [], error: err?.message || String(err) }, 502);
  }
});

// 城市联想：输入任意关键字，返回国内城市候选（高德 inputtips）
app.get("/api/amap/city", async (c) => {
  const q = (c.req.query("q") || "").trim();
  if (!q) return c.json({ tips: [] });
  if (!isAmapConfigured())
    return c.json({ tips: [], enabled: false, error: "未配置 AMAP_KEY，城市搜索不可用" });
  try {
    const j = await amapDistrict(q);
    const tips = (j.districts || [])
      .filter(
        (d: any) =>
          d.name && (!d.level || ["city", "district"].includes(String(d.level))),
      )
      .map((d: any) => ({
        // 高德对直辖市会返回「北京城区」这类名称，统一去掉城市/城区后缀
        name: String(d.name).replace(/(市|城区)$/, ""),
        district: "",
        adcode: String(d.adcode || ""),
        location: String(d.center || ""),
      }))
      .slice(0, 10);
    return c.json({ tips });
  } catch (err: any) {
    return c.json({ tips: [], error: err?.message || String(err) }, 502);
  }
});

app.get("/api/amap/place", async (c) => {
  const keywords = (c.req.query("keywords") || "").trim();
  if (!keywords) return c.json({ error: "缺少参数 keywords" }, 400);
  if (!isAmapConfigured())
    return c.json({ error: "未配置 AMAP_KEY，高德地点搜索不可用", enabled: false }, 503);
  try {
    const j = await amapPlaceText(keywords, c.req.query("city"));
    return c.json(j);
  } catch (err: any) {
    return c.json({ error: err?.message || String(err) }, 502);
  }
});

const LNG_LAT_RE = /^-?\d{1,3}(?:\.\d+)?,-?\d{1,3}(?:\.\d+)?$/;
app.get("/api/amap/route", async (c) => {
  const origin = (c.req.query("origin") || "").trim();
  const destination = (c.req.query("destination") || "").trim();
  const type = c.req.query("type") === "driving" ? "driving" : "walking";
  if (!LNG_LAT_RE.test(origin) || !LNG_LAT_RE.test(destination)) {
    return c.json(
      { error: "origin / destination 须为 lng,lat 格式（经度在前）" },
      400,
    );
  }
  if (!isAmapConfigured())
    return c.json({ error: "未配置 AMAP_KEY，高德路径规划不可用", enabled: false }, 503);
  try {
    const j = await amapRoute(origin, destination, type);
    return c.json(j);
  } catch (err: any) {
    return c.json({ error: err?.message || String(err) }, 502);
  }
});

// 搜索框回车定位：地名 / 城市 / 省份 → 视野中心 + 建议缩放
app.get("/api/amap/locate", async (c) => {
  const q = (c.req.query("q") || "").trim();
  if (!q) return c.json({ error: "缺少参数 q" }, 400);
  if (!isAmapConfigured())
    return c.json({ error: "未配置 AMAP_KEY，地图定位不可用", enabled: false }, 503);
  try {
    const found = await amapLocate(q);
    if (!found) return c.json({ found: false, error: `没有找到「${q}」` }, 404);
    return c.json({ found: true, ...found });
  } catch (err: any) {
    return c.json({ found: false, error: err?.message || String(err) }, 502);
  }
});

app.get("/api/amap/geocode", async (c) => {
  const address = (c.req.query("address") || "").trim();
  if (!address) return c.json({ error: "缺少参数 address" }, 400);
  if (!isAmapConfigured())
    return c.json({ error: "未配置 AMAP_KEY，高德地理编码不可用", enabled: false }, 503);
  try {
    const j = await amapGeocode(address, c.req.query("city"));
    return c.json(j);
  } catch (err: any) {
    return c.json({ error: err?.message || String(err) }, 502);
  }
});

// ---------- 出行天气预报（高德优先 → Open-Meteo 降级 → 失败返回 null 不渲染） ----------
app.get("/api/weather", async (c) => {
  const city = (c.req.query("city") || "苏州").trim();
  const days = Math.min(15, Math.max(1, Number(c.req.query("days")) || 3));
  // 出发日期（可选，YYYY-MM-DD）；不传则从今天开始
  const start = (c.req.query("start") || "").trim() || undefined;
  try {
    const fc = await fetchWeather(city, days, start);
    return c.json({ ok: true, forecast: fc }); // fc 可能为 null，前端据此不渲染
  } catch (err: any) {
    return c.json({ ok: false, forecast: null, error: err?.message || String(err) });
  }
});

// ---------- PgVector 语义检索 ----------
app.get("/api/search", async (c) => {
  const q = (c.req.query("q") || "").trim();
  if (!q) return c.json({ error: "缺少查询参数 q，如 /api/search?q=适合老人的室内景点" }, 400);
  const city = c.req.query("city") || null;
  const limit = Number(c.req.query("limit")) || 8;

  if (!isSemanticReady()) {
    return c.json(
      { error: "语义检索后端未就绪（PG 与本地文件后端均不可用）", db: getDbStatus() },
      503,
    );
  }
  try {
    const hits = await searchPois(q, city, limit);
    return c.json({ query: q, city, count: hits.length, hits });
  } catch (err: any) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ---------- 运行记录 ----------
app.get("/api/runs", async (c) => {
  const limit = Number(c.req.query("limit")) || 20;
  try {
    const runs = await recentRuns(limit);
    return c.json({ dbReady: isDbReady(), count: runs.length, runs });
  } catch (err: any) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
});

// ---------- 核心：驱动 pi Agent Runtime 并 SSE 推送 ----------
interface QueueEvent {
  event: string;
  agent: string;
  detail: any;
}

/** 构造 SSE 帧数据（metrics / run_failed 展开到顶层，其余 detail 嵌套） */
function frameOf(e: QueueEvent) {
  const base = { event: e.event, ts: new Date().toISOString(), agent: e.agent };
  if (e.event === "metrics" || e.event === "run_failed") {
    return JSON.stringify({ ...base, ...(e.detail ?? {}) });
  }
  return JSON.stringify({ ...base, detail: e.detail });
}

/** 高德 POI 类型串 → 内部分类与室内外属性 */
function classifyAmapPoi(type: string): {
  category: "景点" | "餐厅" | "酒店" | "购物" | "机场" | "火车站";
  indoor: "indoor" | "outdoor" | "mixed";
} {
  const t = type || "";
  if (/机场|航站楼|航空/.test(t)) return { category: "机场", indoor: "indoor" };
  if (/火车站|高铁站|动车站|铁路车站/.test(t)) return { category: "火车站", indoor: "indoor" };
  if (/购物|商场|超市|市场|商业街|百货/.test(t)) return { category: "购物", indoor: "indoor" };
  if (/住宿|酒店|宾馆|民宿/.test(t)) return { category: "酒店", indoor: "indoor" };
  if (/美食|餐饮|餐厅|小吃|咖啡|酒吧/.test(t)) return { category: "餐厅", indoor: "indoor" };
  if (/博物馆|展览|美术馆|科技馆|图书馆|剧院|影院|水族馆/.test(t))
    return { category: "景点", indoor: "indoor" };
  if (/公园|广场|风景|山|湖|沙滩|湿地|动物园|植物园/.test(t))
    return { category: "景点", indoor: "outdoor" };
  return { category: "景点", indoor: "mixed" };
}

/**
 * 高德原始 POI → 内部 POI 结构。
 * 在线模式必须完整：不再按分类配额截断，只按高德 id / 名称去重，保留全部拉取到的地点。
 */
function onlineToPois(
  city: string,
  raw: any[],
  opts?: { limit?: number },
): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  const limit = opts?.limit ?? 2000;
  for (const p of raw) {
    const [lngS, latS] = String(p?.location || "").split(",");
    const lng = Number(lngS);
    const lat = Number(latS);
    const name = String(p?.name || "").trim();
    const key = `${name}|${Math.round(lng * 10000)},${Math.round(lat * 10000)}`;
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || seen.has(key)) continue;
    const type = String(p.type || "");
    const { category, indoor } = classifyAmapPoi(type);
    seen.add(key);
    out.push({
      id: `online-${p.id || out.length}`,
      name,
      // 每个地点自带城市（全国搜索时高德会返回 cityname / pname），无则回落到查询城市
      city: String(p.cityname || p.pname || city || ""),
      category,
      lat,
      lng,
      visit_minutes: category === "酒店" ? 0 : 90,
      walking_minutes: 15,
      stairs: 0,
      indoor,
      price_per_person: Number(p.biz_ext?.cost) || 0,
      needs_reservation: false,
      open_hours: String(p.biz_ext?.opentime2 || p.biz_ext?.opentime || ""),
      mobility_note: "",
      address: String(p.address || ""),
      // 高德 POI 图片与评分：地图搜索 / 热门推荐展示用，无数据时前端回退为分类图标
      photo: String(p?.photos?.[0]?.url || ""),
      rating: String(p?.biz_ext?.rating || ""),
      source: "amap_online",
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** 在线全量数据与内置快照合并：同名称视为同一地点，在线字段优先，内置独有地点保留 */
function mergePois(online: any[], builtin: any[]): any[] {
  const byName = new Map<string, any>();
  for (const p of builtin) if (p?.name) byName.set(String(p.name), p);
  for (const p of online) if (p?.name) byName.set(String(p.name), p);
  return [...byName.values()];
}

/**
 * 在线模式确保目标城市已加载全量 POI（内置城市也要拉取，不能只用离线快照）。
 * 返回是否发生了在线拉取；失败时保留已有缓存 / 内置数据。
 */
const ONLINE_POI_TTL_MS = 15 * 60 * 1000;
const onlinePoiFetchedAt = new Map<string, number>();
async function ensureOnlineCityPois(names: string[]): Promise<boolean> {
  let fetched = false;
  for (const name of names) {
    const at = onlinePoiFetchedAt.get(name) || 0;
    // 15 分钟内已拉过全量则直接复用缓存，避免重复请求高德
    if (Date.now() - at < ONLINE_POI_TTL_MS && has_city_snapshot(name)) continue;
    try {
      const raw = await amapCityPoisRaw(name);
      if (!raw.length) continue;
      const online = onlineToPois(name, raw);
      // 高德拉不到城市归属时，内置快照里同城的地点仍保留
      const builtin = has_builtin_snapshot(name) ? load_builtin_pois(name) : [];
      register_city_pois(name, mergePois(online, builtin));
      onlinePoiFetchedAt.set(name, Date.now());
      fetched = true;
    } catch {
      /* 在线拉取失败 → 沿用缓存 / 内置数据 */
    }
  }
  return fetched;
}

/**
 * 地图内搜索 POI：线上走高德 place/text（保留营业时间 / 人均 / 地址等详情），
 * 本地模式只在当前城市快照里做名称 / 分类匹配。返回结构与 /api/pois 一致。
 */
app.get("/api/poi/search", async (c) => {
  const q = (c.req.query("q") || "").trim();
  const city = (c.req.query("city") || "").trim();
  const source = c.req.query("source") === "local" ? "local" : "online";
  if (!q) return c.json({ pois: [], error: "请输入搜索关键词" }, 400);

  // 本地快照模式必须有城市；线上高德模式允许不带城市，直接全国关键词搜索
  if ((source === "local" || !isAmapConfigured()) && !city) {
    return c.json({ pois: [], error: "本地数据模式请先选择目的地城市" }, 400);
  }

  if (source === "local" || !isAmapConfigured()) {
    // 交通枢纽（机场 / 火车站）走全国内置表：离线模式也能在任意主要城市高亮
    const transportCat = q === "机场" || q === "火车站" ? q : null;
    if (transportCat) {
      const hubs = load_transport_pois(city, transportCat);
      return c.json({
        pois: hubs.filter((p: any) => `${p.name || ""}${p.category || ""}`.includes(q)).slice(0, 100),
        source: "local",
      });
    }
    // 其余分类只能用内置快照：未覆盖的城市必须返回空，不能回退苏州数据冒充目标城市
    if (!has_builtin_snapshot(city)) {
      return c.json({
        pois: [],
        source: "local",
        unavailable: true,
        error: `离线模式暂无「${city}」数据，请切换在线模式`,
      });
    }
    const local = load_builtin_pois(city).filter((p: any) =>
      `${p.name || ""}${p.category || ""}${p.address || ""}`.includes(q),
    );
    // 内置快照未收录该分类时，也用全国交通枢纽表补一次（如苏州景点快照里已含枢纽则自然合并）
    const hubs = q === "火车站" || q === "机场" ? load_transport_pois(city, q) : [];
    const merged = [...local];
    for (const h of hubs) if (!merged.some((p: any) => p.name === h.name)) merged.push(h);
    return c.json({ pois: merged.slice(0, 100), source: "local" });
  }
  try {
    // 搜索框必须拿到全部匹配地点：分页拉满，不再只取第一页 20 条
    const raw = await amapPlaceTextAll(q, city || undefined, 5);
    return c.json({
      pois: onlineToPois(city, raw, { limit: 1000 }),
      source: "online",
    });
  } catch (err: any) {
    return c.json({ pois: [], error: err?.message || String(err) }, 502);
  }
});

const MIN_GAP = 160; // 事件间最小间隔（ms）：faux 有动画感，真实 LLM 天然有间隔

app.post("/api/run", async (c) => {
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求体不是合法 JSON" }, 400);
  }

  const city = typeof body.city === "string" ? body.city : "苏州";
  const days = Number.isFinite(Number(body.days)) ? Math.min(7, Math.max(1, Number(body.days))) : 3;
  // 面向用户：不再默认注入模拟扰动；仅当显式传入时才触发重规划（默认空）
  const simulate = typeof body.simulate_disruption === "string" ? body.simulate_disruption : "";
  const modelKey = typeof body.modelKey === "string" ? body.modelKey : undefined;
  const requirement = typeof body.requirement === "string" ? body.requirement : undefined;
  // 结构化偏好：即使模型忽略自然语言，也能在 plan 事件 / faux 脚本里体现用户选择
  const group: string[] = Array.isArray(body.group)
    ? body.group.filter((g: unknown): g is string => typeof g === "string").slice(0, 12)
    : [];
  const transportMode =
    body.transport_mode === "plane" ||
    body.transport_mode === "train" ||
    body.transport_mode === "drive"
      ? (body.transport_mode as "plane" | "train" | "drive")
      : undefined;
  const budget = Number.isFinite(Number(body.budget)) && Number(body.budget) > 0
    ? Number(body.budget)
    : undefined;
  const pace =
    body.pace === "relaxed" ||
    body.pace === "moderate" ||
    body.pace === "tight"
      ? body.pace
      : undefined;
  const afternoonIndoor =
    typeof body.afternoon_indoor === "boolean"
      ? body.afternoon_indoor
      : undefined;
  const mustHaveLunch =
    typeof body.must_have_lunch === "boolean"
      ? body.must_have_lunch
      : undefined;
  const mustVisit: string[] = Array.isArray(body.must_visit)
    ? body.must_visit
        .filter((v: unknown): v is string => typeof v === "string")
        .map((v: string) => v.trim())
        .filter(Boolean)
        .slice(0, 20)
    : [];
  const avoid: string[] = Array.isArray(body.avoid)
    ? body.avoid
        .filter((v: unknown): v is string => typeof v === "string")
        .map((v: string) => v.trim())
        .filter(Boolean)
        .slice(0, 12)
    : [];

  // 城市校验：支持逗号分隔的多城市
  const requested = city.split(/[,，、\s]+/).filter(Boolean);
  if (!requested.length) return c.json({ error: "请选择目的地城市" }, 400);
  const source = body.source === "local" ? "local" : "online";
  if (source === "local") {
    // 本地演示模式：只用内置快照，不访问高德
    if (!requested.some((n: string) => has_builtin_snapshot(n))) {
      return c.json({ error: `本地数据仅支持${list_cities().join("、")}` }, 422);
    }
  } else if (isAmapConfigured()) {
    // 规划求解也要用在线全量 POI，而不是内置快照的 10 个景点
    await ensureOnlineCityPois(requested);
    // 任意城市都拿不到 POI 时直接报错，避免用苏州数据硬凑行程
    if (!requested.some((n: string) => has_city_snapshot(n))) {
      return c.json(
        { error: `暂时拿不到「${requested.join("、")}」的景点数据，请稍后重试或更换城市` },
        422,
      );
    }
  }

  // 未显式指定模型时自动选择第一个已配置 Key 的模型（国内优先），都没配则回退 faux
  const selectedModel = modelKey ? getModelEntry(modelKey) : pickDefaultModel();
  const effectiveModelKey = selectedModel?.key;
  const modelConfigured = selectedModel ? isModelConfigured(selectedModel) : false;
  const mode = modelConfigured ? "pi-runtime:real" : "pi-runtime:faux";

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      data: JSON.stringify({
        event: "run_started",
        ts: new Date().toISOString(),
        city,
        days,
        simulate_disruption: simulate,
        model: selectedModel
          ? { key: selectedModel.key, label: selectedModel.label, configured: modelConfigured }
          : null,
        mode,
        preferences: {
          group,
          pace: pace ?? null,
          afternoon_indoor: afternoonIndoor ?? null,
          must_have_lunch: mustHaveLunch ?? null,
          must_visit: mustVisit,
          avoid,
          budget: budget ?? null,
        },
      }),
    });

    // 并发事件队列：runtime 实时推事件入队，drain 循环按最小间隔消费
    const queue: QueueEvent[] = [];
    const recorded: QueueEvent[] = []; // 落库用（截断）
    let done = false;
    let runError: any = null;
    let runHadModelError = false;
    let metricsSnapshot: any = null;

    let resolveWake: () => void = () => {};
    let wakeP = new Promise<void>((r) => {
      resolveWake = r;
    });
    const wake = () => {
      const r = resolveWake;
      wakeP = new Promise<void>((rr) => {
        resolveWake = rr;
      });
      r();
    };
    const push = (event: string, agent: string, detail: any) => {
      const e = { event, agent, detail };
      queue.push(e);
      if (recorded.length < 200) recorded.push(e);
      if (event === "metrics") metricsSnapshot = detail;
      wake();
    };

    const runPromise = runAgentRuntime(
      {
        city,
        days,
        simulate_disruption: simulate,
        modelKey: effectiveModelKey,
        requirement,
        group,
        pace,
        afternoon_indoor: afternoonIndoor,
        must_have_lunch: mustHaveLunch,
        must_visit: mustVisit,
        avoid,
        transport_mode: transportMode,
        budget,
      },
      push,
    )
      .then((r) => {
        if (r.error) runHadModelError = true;
      })
      .catch((err) => {
        runError = err;
        push("run_failed", "Supervisor", { error: err?.message || String(err) });
      })
      .finally(() => {
        done = true;
        wake();
      });

    let last = 0;
    let alive = true;
    while (!(done && queue.length === 0)) {
      if (queue.length === 0) {
        await wakeP;
        continue;
      }
      const e = queue.shift()!;
      const now = Date.now();
      if (last && now - last < MIN_GAP) {
        try {
          await stream.sleep(MIN_GAP - (now - last));
        } catch {
          alive = false;
          break;
        }
      }
      try {
        await stream.writeSSE({ data: frameOf(e) });
      } catch {
        alive = false;
        break;
      }
      last = Date.now();
    }

    if (alive && !runError && !runHadModelError) {
      try {
        await stream.writeSSE({
          data: JSON.stringify({
            event: "run_completed",
            ts: new Date().toISOString(),
            agent: "Supervisor",
            ok: true,
          }),
        });
      } catch {
        /* 客户端已断开 */
      }
    }

    await runPromise; // 等 runtime settled（客户端断开时结果丢弃）

    // 运行记录落库（失败静默）
    if (!runHadModelError && !runError) {
      void saveRun({
        city,
        days,
        mode,
        model: selectedModel?.label,
        total_cost: metricsSnapshot?.total_cost,
        item_count: metricsSnapshot?.item_count,
        constraint_pass_rate: metricsSnapshot?.constraint_pass_rate,
        hallucination_rate: metricsSnapshot?.hallucination_rate,
        resilience_score: metricsSnapshot?.resilience_score,
        events: recorded,
      });
    }
  });
});

// ---------- 静态托管（生产 web/dist，SPA 回退） ----------
app.use(
  "/*",
  serveStatic({
    root: WEB_DIST,
    rewriteRequestPath: (p) => {
      if (p.includes("..")) return "/__forbidden__";
      // API 路径不做 SPA 回退：交给 notFound 返回结构化 JSON 404，
      // 否则前端会把 index.html 当成接口响应解析失败。
      if (p.startsWith("/api/")) return "/__api_not_found__";
      const rel = p === "/" ? "/index.html" : p;
      const abs = path.join(WEB_DIST, rel);
      try {
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return rel;
      } catch {
        /* ignore */
      }
      return "/index.html"; // SPA 回退
    },
  }),
);

app.notFound((c) => {
  const p = new URL(c.req.url).pathname;
  if (p.startsWith("/api/")) return c.json({ error: "not found", path: p }, 404);
  if (!fs.existsSync(path.join(WEB_DIST, "index.html"))) {
    return c.json({ error: "前端未构建：请先运行 npm run build:web" }, 404);
  }
  return c.json({ error: "not found", path: p }, 404);
});

app.onError((err, c) => {
  console.error("[server] 未捕获错误：", err);
  return c.json({ error: err?.message || String(err) }, 500);
});

export default app;
export { WEB_DIST };
