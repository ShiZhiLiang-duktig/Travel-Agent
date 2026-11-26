/**
 * 航班班次/余票查询：接入 MCP 兼容的航班数据源（当前验证通过：魔搭托管的 variflight 飞常准）。
 *
 * 配置（服务端 .env）：
 *   FLIGHT_MCP_URL   必填，数据源地址（等同凭证）。两种写法都支持：
 *                    - Streamable HTTP：https://mcp.api-inference.modelscope.net/<专属ID>/mcp
 *                    - 旧版 HTTP+SSE：  https://mcp.api-inference.modelscope.net/sse/<专属ID>
 *   FLIGHT_MCP_TOOL  可选，工具名；留空时自动挑选（优先带票价/余票的工具，其次航班查询工具）
 *
 * 工具选择策略（variflight 实测有 9 个工具）：
 *   getFlightPriceByCities   含舱位余票数 + 票面价 + 机建燃油 → 首选，能回答「有没有票、多少钱」
 *   searchFlightsByDepArr    只有时刻表与准点率 → 次选，余票标注「以航司为准」
 *
 * 参数拼装：按工具 inputSchema 自动适配（dep_city/arr_city、depcity/arrcity、dep/arr 等），
 * 城市名自动转 IATA 三字码；枚举字段（如 detail: full|summary）自动填合法值，
 * 不会像早期版本那样塞空字符串导致 -32602 参数校验失败。
 *
 * 失败策略：任何异常都不抛出，把原因放进 FlightQueryResult.error，
 * 由城际交通卡片如实展示（而不是伪装成「查不到班次」）。
 */
const MCP_URL = (process.env.FLIGHT_MCP_URL || "").trim();
const TOOL_NAME = (process.env.FLIGHT_MCP_TOOL || "").trim();

/** 旧版 SSE 传输：地址里带 /sse 段（魔搭托管的另一种表单） */
const IS_SSE = /\/sse\b/.test(MCP_URL);

export function isFlightConfigured(): boolean {
  return !!MCP_URL;
}

/** 地址明显是残缺的（魔搭域名下直接 /mcp 或 //mcp，缺专属 ID）时提前报错，避免只看到 404 */
function urlProblem(url: string): string | null {
  if (!/^https?:\/\//i.test(url)) return "FLIGHT_MCP_URL 需要以 http(s):// 开头";
  if (/modelscope\.net\/+mcp\/?$/.test(url) || /modelscope\.net\/sse\/?$/.test(url)) {
    return "FLIGHT_MCP_URL 缺少专属服务 ID（应形如 .../net/<专属ID>/mcp 或 .../net/sse/<专属ID>）";
  }
  return null;
}

export interface FlightCabin {
  /** 舱位名，如「经济舱」「公务舱」 */
  name: string;
  /** 票面价（不含机建燃油） */
  price: number;
  /** 该舱位余票数 */
  seats: number;
}

export interface FlightTicket {
  /** 航班号，如 MU5228 */
  code: string;
  /** 出发 / 到达机场三字码 */
  from_airport: string;
  to_airport: string;
  /** 机场中文名，如「天津滨海」 */
  from_name?: string;
  to_name?: string;
  /** 航站楼，如 T2 */
  from_terminal?: string;
  to_terminal?: string;
  /** HH:mm */
  depart: string;
  arrive: string;
  duration_min?: number;
  /** 票面价（经济舱最低） */
  base_price?: number;
  /** 机建 + 燃油附加费 */
  tax?: number;
  /** 含税总价（票面价 + 机建燃油），展示用 */
  price?: number;
  /** 经济舱余票数 */
  seats?: number;
  aircraft?: string;
  /** 准点率，如 96.67% */
  ontime?: string;
  cabins?: FlightCabin[];
  /** 可展示的余票结论，如「余票 9 张」「无余票」 */
  status: string;
}

export interface FlightQueryResult {
  /** 是否配置了数据源 */
  configured: boolean;
  list: FlightTicket[];
  /** 实际调用的工具名 */
  tool?: string;
  /** 是否拿到了票价/余票（false 表示只有时刻表） */
  priced?: boolean;
  /** 失败原因（可直接展示给用户） */
  error?: string;
}

const OK_CACHE = new Map<string, { at: number; res: Omit<FlightQueryResult, "configured"> }>();
const FAIL_CACHE = new Map<string, { at: number; error: string; tool?: string }>();
const TTL = 10 * 60 * 1000;
const FAIL_TTL = 60 * 1000;
const TIMEOUT = 15000;

let sessionId = "";
let rpcId = 0;
let discoveredTool = "";

// ── 传输层：Streamable HTTP ───────────────────────────────────────────

async function httpRpc(method: string, params: unknown, notify = false): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(
        notify
          ? { jsonrpc: "2.0", method, params }
          : { jsonrpc: "2.0", id: ++rpcId, method, params },
      ),
      signal: ctrl.signal,
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `MCP HTTP ${res.status}${/record not found/i.test(body) ? "（地址不完整或服务未部署）" : res.status === 401 || res.status === 403 ? "（地址或鉴权失效）" : ""}`,
      );
    }
    const text = await res.text();
    if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
      const lines = text.split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw.startsWith("{")) continue;
        try {
          return JSON.parse(raw);
        } catch {
          /* 继续找上一条 */
        }
      }
      throw new Error("MCP SSE 响应无法解析");
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// ── 传输层：旧版 HTTP+SSE（GET 长连接 + POST 到 endpoint） ─────────────

type Waiter = { resolve: (v: any) => void; reject: (e: any) => void };
const ssePending = new Map<number, Waiter>();
let sseEndpoint = "";
let sseReady: Promise<string> | null = null;
let sseController: AbortController | null = null;
let sseResolveEndpoint: ((url: string) => void) | null = null;

function handleSseEvent(raw: string): void {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  const payload = data.join("\n").trim();
  if (!payload) return;
  if (event === "endpoint") {
    const abs = /^https?:/i.test(payload) ? payload : new URL(payload, MCP_URL).toString();
    sseEndpoint = abs;
    sseResolveEndpoint?.(abs);
    return;
  }
  if (!payload.startsWith("{")) return;
  try {
    const msg = JSON.parse(payload);
    const id = Number(msg?.id);
    const waiter = ssePending.get(id);
    if (waiter) {
      ssePending.delete(id);
      waiter.resolve(msg);
    }
  } catch {
    /* 忽略无法解析的心跳 */
  }
}

/** 建立 SSE 长连接，返回消息投递地址（含 sessionId） */
function startSse(): Promise<string> {
  if (sseReady) return sseReady;
  sseController = new AbortController();
  sseReady = new Promise<string>((resolve, reject) => {
    sseResolveEndpoint = resolve;
    const timer = setTimeout(() => {
      if (!sseEndpoint) reject(new Error("SSE 连接超时（未收到 endpoint 事件）"));
    }, TIMEOUT);

    (async () => {
      try {
        const res = await fetch(MCP_URL, {
          method: "GET",
          headers: { Accept: "text/event-stream" },
          signal: sseController!.signal,
        });
        const sid = res.headers.get("mcp-session-id");
        if (sid) sessionId = sid;
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(
            `MCP SSE HTTP ${res.status}${/record not found/i.test(body) ? "（地址不完整或服务未部署）" : ""}`,
          );
        }
        const reader = res.body?.getReader();
        if (!reader) throw new Error("SSE 响应没有 body");
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx = buf.indexOf("\n\n");
          while (idx >= 0) {
            handleSseEvent(buf.slice(0, idx));
            buf = buf.slice(idx + 2);
            idx = buf.indexOf("\n\n");
          }
        }
        throw new Error("SSE 连接被服务端关闭");
      } catch (err: any) {
        if (!sseEndpoint) reject(err);
        for (const [, w] of ssePending) w.reject(new Error("SSE 连接已断开"));
        ssePending.clear();
        sseReady = null;
        sseEndpoint = "";
      } finally {
        clearTimeout(timer);
      }
    })();
  });
  return sseReady;
}

async function ssePost(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`MCP 消息投递失败 HTTP ${res.status}`);
}

async function sseRpc(method: string, params: unknown, notify = false): Promise<any> {
  const url = await startSse();
  if (notify) {
    await ssePost(url, { jsonrpc: "2.0", method, params }).catch(() => {});
    return null;
  }
  const id = ++rpcId;
  const wait = new Promise<any>((resolve, reject) => {
    ssePending.set(id, { resolve, reject });
    setTimeout(() => {
      if (ssePending.delete(id)) reject(new Error(`SSE 调用超时：${method}`));
    }, TIMEOUT);
  });
  await ssePost(url, { jsonrpc: "2.0", id, method, params });
  return wait;
}

function rpc(method: string, params: unknown, notify = false): Promise<any> {
  return IS_SSE ? sseRpc(method, params, notify) : httpRpc(method, params, notify);
}

/** 会话失效时彻底重置（下次调用重新握手 / 重连） */
function resetSession(): void {
  sessionId = "";
  sseEndpoint = "";
  sseReady = null;
  sseResolveEndpoint = null;
  try {
    sseController?.abort();
  } catch {
    /* ignore */
  }
  sseController = null;
  for (const [, w] of ssePending) w.reject(new Error("会话已重置"));
  ssePending.clear();
}

async function ensureSession(): Promise<void> {
  if (sessionId && (!IS_SSE || sseEndpoint)) return;
  const r = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "tuwen-travel-agent", version: "1.0.0" },
  });
  if (r?.error) throw new Error(r.error.message || "MCP 初始化失败");
  await rpc("notifications/initialized", {}, true).catch(() => {});
}

// ── 工具发现与参数拼装 ────────────────────────────────────────────────

interface ToolMeta {
  name: string;
  properties: Record<string, any>;
  required: string[];
}

async function listTools(): Promise<ToolMeta[]> {
  try {
    const r = await rpc("tools/list", {});
    const tools: any[] = r?.result?.tools || [];
    return tools
      .filter((t) => t?.name)
      .map((t) => ({
        name: String(t.name),
        properties: t?.inputSchema?.properties || {},
        required: Array.isArray(t?.inputSchema?.required) ? t.inputSchema.required : [],
      }));
  } catch {
    return [];
  }
}

/** 有票价/余票数据的工具优先（能回答「有没有票、多少钱」），其次才是时刻表工具 */
const PRICE_TOOL_RE = /(price|fare|cabin|ticket)/i;
const FLIGHT_TOOL_RE = /flight|air|机票|航班|itinerar/i;

function scoreTool(t: ToolMeta): number {
  const hasPair =
    (pickKey(t.properties, CITY_FROM_KEYS) || pickKey(t.properties, AIR_FROM_KEYS)) &&
    (pickKey(t.properties, CITY_TO_KEYS) || pickKey(t.properties, AIR_TO_KEYS));
  let score = 0;
  if (PRICE_TOOL_RE.test(t.name)) score += 10;
  if (FLIGHT_TOOL_RE.test(t.name)) score += 5;
  if (hasPair) score += 3;
  if (pickKey(t.properties, DATE_KEYS)) score += 2;
  return score;
}

async function resolveTool(): Promise<ToolMeta | null> {
  const tools = await listTools();
  if (TOOL_NAME) {
    const hit = tools.find((t) => t.name === TOOL_NAME);
    return hit || { name: TOOL_NAME, properties: {}, required: [] };
  }
  if (!tools.length) return null;
  const ranked = [...tools].sort((a, b) => scoreTool(b) - scoreTool(a));
  const hit =
    (discoveredTool ? ranked.find((t) => t.name === discoveredTool) : undefined) || ranked[0];
  discoveredTool = hit.name;
  return hit;
}

/**
 * 城市 → IATA 城市三字码（depcity / dep_city 用）。
 * 多机场城市必须用城市码（北京 BJS 而非 PEK），其余多数城市与机场码相同。
 */
const CITY_CODE: Record<string, string> = {
  北京: "BJS", 上海: "SHA", 成都: "CTU", 天津: "TSN", 重庆: "CKG", 广州: "CAN", 深圳: "SZX",
  杭州: "HGH", 南京: "NKG", 武汉: "WUH", 西安: "XIY", 长沙: "CSX", 郑州: "CGO", 昆明: "KMG",
  厦门: "XMN", 青岛: "TAO", 大连: "DLC", 沈阳: "SHE", 哈尔滨: "HRB", 长春: "CGQ", 济南: "TNA",
  合肥: "HFE", 福州: "FOC", 南昌: "KHN", 太原: "TYN", 石家庄: "SJW", 呼和浩特: "HET",
  南宁: "NNG", 海口: "HAK", 三亚: "SYX", 贵阳: "KWE", 兰州: "LHW", 银川: "INC", 西宁: "XNN",
  乌鲁木齐: "URC", 拉萨: "LXA", 无锡: "WUX", 苏州: "WUX", 常熟: "WUX", 张家港: "WUX",
  昆山: "SHA", 太仓: "SHA", 宁波: "NGB", 温州: "WNZ", 珠海: "ZUH", 桂林: "KWL",
  丽江: "LJG", 西双版纳: "JHG", 张家界: "DYG", 烟台: "YNT", 常州: "CZX", 南通: "NTG",
  泉州: "JJN", 汕头: "SWA", 惠州: "HUZ", 徐州: "XUZ", 扬州: "YTY", 洛阳: "LYA", 宜昌: "YIH",
  襄阳: "XFN", 威海: "WEH", 绵阳: "MIG", 泸州: "LZO", 遵义: "ZYI", 鄂尔多斯: "DSN",
  包头: "BAV", 呼伦贝尔: "HLD", 喀什: "KHG", 敦煌: "DNH", 嘉峪关: "JGN", 西昌: "XIC",
  大理: "DLU", 腾冲: "TCZ", 北海: "BHY", 湛江: "ZHA", 赣州: "KOW", 黄山: "TXN", 义乌: "YIW",
  舟山: "HSN", 临沂: "LYI", 济宁: "JNG", 大同: "DAT", 运城: "YCU", 秦皇岛: "BPE", 唐山: "TVS",
  邯郸: "HDG", 张家口: "ZQZ", 赤峰: "CIF", 牡丹江: "MDG", 佳木斯: "JMU", 齐齐哈尔: "NDG",
  大庆: "DQA", 延吉: "YNJ", 丹东: "DDG", 锦州: "JNZ", 乌兰浩特: "HLH", 满洲里: "NZH",
  香港: "HKG", 澳门: "MFM", 台北: "TPE",
};

/** 城市 → 机场三字码（dep / arr 用；多机场城市取主机场） */
const AIRPORT_CODE: Record<string, string> = {
  ...CITY_CODE,
  北京: "PEK",
  成都: "CTU",
  上海: "SHA",
};

export function flightCityCode(city: string): string {
  const name = String(city || "").replace(/市$/, "").trim();
  if (/^[A-Z]{3}$/.test(name)) return name;
  return CITY_CODE[name] || name;
}

export function flightAirportCode(city: string): string {
  const name = String(city || "").replace(/市$/, "").trim();
  if (/^[A-Z]{3}$/.test(name)) return name;
  return AIRPORT_CODE[name] || name;
}

/** 出发城市（城市级）字段名候选 */
const CITY_FROM_KEYS = [
  "depcity", "dep_city", "from_city", "fromCity", "depCity", "departureCity",
  "departure_city", "originCity", "origin_city", "startCity", "start_city", "depcitycode",
];
/** 到达城市（城市级）字段名候选 */
const CITY_TO_KEYS = [
  "arrcity", "arr_city", "to_city", "toCity", "arrCity", "arrivalCity",
  "arrival_city", "destinationCity", "destination_city", "endCity", "end_city", "arrcitycode",
];
/** 出发机场（机场级）字段名候选 */
const AIR_FROM_KEYS = ["dep", "from", "fromAirport", "from_airport", "depAirport", "dep_airport", "departureAirport"];
/** 到达机场（机场级）字段名候选 */
const AIR_TO_KEYS = ["arr", "to", "toAirport", "to_airport", "arrAirport", "arr_airport", "arrivalAirport"];
const DATE_KEYS = [
  "dep_date", "depDate", "date", "departureDate", "departure_date", "flightDate", "ddate", "day",
  "startDate", "start_date",
];

function pickKey(props: Record<string, any>, candidates: string[]): string | null {
  const keys = Object.keys(props || {});
  for (const c of candidates) {
    const hit = keys.find((k) => k.toLowerCase() === c.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** 枚举字段取第一个合法值，避免传空串触发 -32602 参数校验错误 */
function firstEnum(v: any): string | null {
  const list = v?.enum;
  return Array.isArray(list) && list.length ? String(list[0]) : null;
}

/**
 * 按工具 schema 拼参数。
 * 原则：只填 schema 里真实存在的字段；城市优先用「城市码」字段，只有机场字段时才用机场码；
 * 枚举 / 数字字段绝不填空串（这正是早期版本 -32602 失败的原因）。
 */
function buildArgs(
  tool: ToolMeta | null,
  from: string,
  to: string,
  date: string,
): Record<string, unknown> {
  const props = tool?.properties || {};
  const args: Record<string, unknown> = {};
  if (!Object.keys(props).length) return { from, to, date };

  const cityFrom = pickKey(props, CITY_FROM_KEYS);
  const cityTo = pickKey(props, CITY_TO_KEYS);
  const airFrom = pickKey(props, AIR_FROM_KEYS);
  const airTo = pickKey(props, AIR_TO_KEYS);

  if (cityFrom) args[cityFrom] = flightCityCode(from);
  else if (airFrom) args[airFrom] = flightAirportCode(from);
  if (cityTo) args[cityTo] = flightCityCode(to);
  else if (airTo) args[airTo] = flightAirportCode(to);

  const dateKey = pickKey(props, DATE_KEYS);
  if (dateKey) args[dateKey] = date;

  // 其余字段按类型给合法默认值（只填非必填的可选字段，尽量让数据源返回完整信息）
  for (const [k, v] of Object.entries(props)) {
    if (k in args) continue;
    const type = String(v?.type || "");
    if (Array.isArray(v?.enum)) {
      const val = firstEnum(v);
      if (val) args[k] = val;
      continue;
    }
    if (type === "integer" || type === "number") {
      // limit 限制条数；offset 从 0 开始
      if (/offset|page/i.test(k)) args[k] = 0;
      else if (/limit|count|size|num/i.test(k)) args[k] = 10;
      continue;
    }
    if (type === "boolean" && tool?.required.includes(k)) args[k] = false;
  }
  return args;
}

// ── 结果解析 ─────────────────────────────────────────────────────────

const TIME_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
const PRICE_RE = /(?:¥|￥)\s*(\d{2,5})|(\d{2,5})\s*元/;
const STATUS_RE = /有票|无票|售罄|候补|充足|剩余\s*\d+\s*张|可订|余票/;
const CODE_RE = /\b([A-Z0-9]{2}\d{3,4})\b/;

const normTime = (h: string, m: string) => `${String(Number(h)).padStart(2, "0")}:${m}`;

/** 秒级 / 毫秒级时间戳 → 北京时间 HH:mm */
function hhmmFromStamp(v: any): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return "";
  const sec = n > 1e12 ? n / 1000 : n;
  const d = new Date((sec + 8 * 3600) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** "2026-11-28 18:00:00" / "18:00" 等 → HH:mm */
function hhmmFromText(v: any): string {
  const s = String(v ?? "");
  const m = s.match(/([01]?\d|2[0-3]):([0-5]\d)/);
  return m ? normTime(m[1], m[2]) : "";
}

const num = (v: any): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** 从航司原始 JSON 里解析航班（variflight: {code:200, data:[{flightno, cabins:[...]}]}） */
function parseRows(rows: any[]): FlightTicket[] {
  const out: FlightTicket[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const code = String(r.flightno || r.FlightNo || r.flightNo || r.code || r.flightNumber || "").trim();
    if (!code) continue;

    const depart =
      hhmmFromStamp(r.flightdeptimeplandate) ||
      hhmmFromText(r.FlightDeptimePlanDate) ||
      hhmmFromText(r.depart || r.depTime || r.departureTime || r.dep_time) ||
      hhmmFromText(r.FlightDeptimeReadyDate) ||
      "";
    const arrive =
      hhmmFromStamp(r.flightarrtimeplandate) ||
      hhmmFromText(r.FlightArrtimePlanDate) ||
      hhmmFromText(r.arrive || r.arrTime || r.arrivalTime || r.arr_time) ||
      hhmmFromText(r.FlightArrtimeReadyDate) ||
      "";
    if (!depart) continue;

    const cabinsRaw: any[] = Array.isArray(r.cabins) ? r.cabins : [];
    const cabins: FlightCabin[] = cabinsRaw
      .map((c) => ({
        name: String(c.classname || c.cabinname || c.cabinclass || ""),
        price: Number(c.price) || 0,
        seats: Number(c.seatnum ?? c.seats ?? 0) || 0,
      }))
      .filter((c) => c.price > 0);

    const isEco = (c: FlightCabin) => /经济|Y/i.test(c.name) || c.name === "Y";
    const eco = cabins.filter(isEco).sort((a, b) => a.price - b.price)[0] || null;
    const cheapest = eco || [...cabins].sort((a, b) => a.price - b.price)[0] || null;

    const tax = (num(r.oilfee) || 0) + (num(r.tax) || 0);
    const base = cheapest?.price;
    const seats = eco?.seats ?? cheapest?.seats;

    const duration = num(r.FlightDuration)
      ? Number(r.FlightDuration)
      : (() => {
          const d = Number(r.flightdeptimeplandate);
          const a = Number(r.flightarrtimeplandate);
          return d > 0 && a > d ? Math.round((a - d) / 60) : undefined;
        })();

    const statusText =
      seats === undefined
        ? "余票以航司为准"
        : seats > 0
          ? `余票 ${seats} 张`
          : "无余票";

    out.push({
      code,
      from_airport: String(r.flightdepcode || r.FlightDepcode || r.dep || r.from || ""),
      to_airport: String(r.flightarrcode || r.FlightArrcode || r.arr || r.to || ""),
      from_name: String(r.depaptcname || r.FlightDepAirport || r.depAirport || ""),
      to_name: String(r.arraptcname || r.FlightArrAirport || r.arrAirport || ""),
      from_terminal: String(r.flighthterminal || r.FlightHTerminal || r.depTerminal || ""),
      to_terminal: String(r.flightterminal || r.FlightTerminal || r.arrTerminal || ""),
      depart,
      arrive,
      duration_min: duration,
      base_price: base,
      tax: tax || undefined,
      price: base ? base + tax : undefined,
      seats,
      aircraft: String(r.generic || r.ftype || r.aircraft || "").trim() || undefined,
      ontime: String(r.OntimeRate || r.ontime || "").trim() || undefined,
      cabins: cabins.length ? cabins : undefined,
      status: statusText,
    });
  }
  return out.sort((a, b) => a.depart.localeCompare(b.depart));
}

/** 归一化航班结果：航司 JSON / 通用 JSON / Markdown 表格 / 纯文本行 */
export function parseFlights(text: string): FlightTicket[] {
  const raw = String(text || "").trim();
  if (!raw) return [];

  try {
    const j = JSON.parse(raw);
    const rows: any[] = Array.isArray(j)
      ? j
      : Array.isArray(j?.data)
        ? j.data
        : Array.isArray(j?.flights)
          ? j.flights
          : Array.isArray(j?.result)
            ? j.result
            : [];
    const out = parseRows(rows);
    if (out.length) return out;
  } catch {
    /* 非 JSON，走文本解析 */
  }

  const out: FlightTicket[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const codeMatch = s.match(CODE_RE);
    if (!codeMatch) continue;
    const code = codeMatch[1];
    const times = [...s.matchAll(TIME_RE)].map((x) => normTime(x[1], x[2]));
    if (!times.length) continue;
    const price = s.match(PRICE_RE);
    const status = s.match(STATUS_RE);
    const key = `${code}-${times[0]}-${times[1] || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      code,
      from_airport: "",
      to_airport: "",
      depart: times[0],
      arrive: times[1] || "",
      price: price ? Number(price[1] || price[2]) : undefined,
      status: status ? status[0] : "余票以航司为准",
    });
  }
  return out;
}

const textOf = (res: any): string =>
  ((res?.result?.content || []) as any[])
    .map((c) => (typeof c?.text === "string" ? c.text : ""))
    .join("\n");

export interface FlightSourceHealth {
  configured: boolean;
  /** 传输方式：地址带 /sse 视为旧版 SSE，否则 Streamable HTTP */
  protocol: "streamable_http" | "sse" | "none";
  ok: boolean;
  tools?: string[];
  chosen?: string;
  error?: string;
}

/** 接入自检：只做握手与 tools/list，不查真实航班，方便配完立刻验证（不泄露 URL） */
export async function checkFlightSource(): Promise<FlightSourceHealth> {
  const protocol: FlightSourceHealth["protocol"] = !MCP_URL
    ? "none"
    : IS_SSE
      ? "sse"
      : "streamable_http";
  if (!MCP_URL)
    return { configured: false, protocol, ok: false, error: "未配置 FLIGHT_MCP_URL" };
  const bad = urlProblem(MCP_URL);
  if (bad) return { configured: true, protocol, ok: false, error: bad };
  try {
    await ensureSession();
    const tools = await listTools();
    const chosen = (await resolveTool())?.name;
    return {
      configured: true,
      protocol,
      ok: tools.length > 0,
      tools: tools.map((t) => t.name),
      chosen,
      ...(tools.length ? {} : { error: "数据源没有暴露任何工具（tools/list 为空）" }),
    };
  } catch (err: any) {
    resetSession();
    return {
      configured: true,
      protocol,
      ok: false,
      error: String(err?.message || err || "连接失败").slice(0, 200),
    };
  }
}

/** 查航班：永不抛错，失败原因放在返回值里 */
export async function queryFlights(
  from: string,
  to: string,
  date: string,
): Promise<FlightQueryResult> {
  if (!MCP_URL) return { configured: false, list: [] };
  const bad0 = urlProblem(MCP_URL);
  if (bad0) return { configured: true, list: [], error: bad0 };

  const key = `${from}|${to}|${date}`;
  const ok = OK_CACHE.get(key);
  if (ok && Date.now() - ok.at < TTL) return { configured: true, ...ok.res };
  const bad = FAIL_CACHE.get(key);
  if (bad && Date.now() - bad.at < FAIL_TTL)
    return { configured: true, list: [], error: bad.error, tool: bad.tool };

  let toolName = TOOL_NAME || discoveredTool;
  try {
    await ensureSession();
    const tool = await resolveTool();
    if (!tool) throw new Error("数据源没有暴露任何工具（tools/list 为空）");
    toolName = tool.name;
    const args = buildArgs(tool, from, to, date);
    const res = await rpc("tools/call", { name: tool.name, arguments: args });
    if (res?.error) throw new Error(res.error.message || "MCP 调用失败");
    if (res?.result?.isError) throw new Error(textOf(res).slice(0, 160) || "数据源返回错误");

    const list = parseFlights(textOf(res));
    if (!list.length) {
      const msg = `数据源（${tool.name}）有响应但没有可解析的航班，可能当天无航班或城市码不被支持`;
      FAIL_CACHE.set(key, { at: Date.now(), error: msg, tool: toolName });
      return { configured: true, list: [], error: msg, tool: toolName };
    }
    const priced = list.some((f) => f.price !== undefined || f.seats !== undefined);
    const result = { list, tool: toolName, priced };
    OK_CACHE.set(key, { at: Date.now(), res: result });
    FAIL_CACHE.delete(key);
    return { configured: true, ...result };
  } catch (err: any) {
    resetSession();
    const msg = String(err?.message || err || "调用失败").slice(0, 200);
    FAIL_CACHE.set(key, { at: Date.now(), error: msg, tool: toolName });
    return { configured: true, list: [], error: msg, tool: toolName };
  }
}
