/**
 * 12306 余票查询：通过 ModelScope Hosted MCP（Streamable HTTP）调用 get-tickets。
 *
 * 配置：环境变量 RAILWAY_MCP_URL（MCP 服务地址，属于敏感信息，只放服务端 .env）
 * 数据：车次、发到站、时刻、历时、席别票价与余票；结果缓存 10 分钟。
 * 失败策略：返回 null / 抛错由调用方回退到经验估算，不影响主流程。
 */
const MCP_URL = (process.env.RAILWAY_MCP_URL || "").trim();

export function isRailwayConfigured(): boolean {
  return !!MCP_URL;
}

export interface TrainSeat {
  name: string;
  /** 余票状态：有票 / 无票 / 剩余 6 张票 */
  status: string;
  price: number;
}

export interface TrainTicket {
  code: string;
  from_station: string;
  to_station: string;
  depart: string;
  arrive: string;
  duration_min: number;
  seats: TrainSeat[];
}

/** 查询结果缓存：余票变化快，10 分钟足够，避免频繁请求第三方 */
const TICKET_CACHE = new Map<string, { at: number; list: TrainTicket[] }>();
const TTL = 10 * 60 * 1000;

let sessionId = "";
let rpcId = 0;

/** 单次 JSON-RPC 调用，兼容 application/json 与 text/event-stream 两种响应 */
async function rpc(
  method: string,
  params: unknown,
  notify = false,
): Promise<any> {
  const body = notify
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id: ++rpcId, method, params };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    const text = await res.text();
    const ctype = res.headers.get("content-type") || "";
    if (ctype.includes("text/event-stream")) {
      // SSE：逐行取 data: 后的 JSON，返回最后一个可解析的消息
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

/** 建立会话（Hosted MCP 需要 initialize + initialized），复用 session 减少往返 */
async function ensureSession(): Promise<void> {
  if (sessionId) return;
  const r = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "tuwen-travel-agent", version: "1.0.0" },
  });
  if (r?.error) throw new Error(r.error.message || "MCP 初始化失败");
  await rpc("notifications/initialized", {}, true).catch(() => {});
}

/** 解析工具返回的 markdown 文本：车次头 + 席别行 */
export function parseTickets(text: string): TrainTicket[] {
  const out: TrainTicket[] = [];
  let cur: TrainTicket | null = null;
  const headRe =
    /^(\S+)\s+(\S+)\(telecode:[A-Z]+\)\s*->\s*(\S+)\(telecode:[A-Z]+\)\s+(\d{2}:\d{2})\s*->\s*(\d{2}:\d{2})\s*历时：\s*(\d{1,2}):(\d{2})/;
  const seatRe = /^[-•]\s*([^:：]+)[:：]\s*(.+?)\s*(\d+(?:\.\d+)?)\s*元/;

  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const h = line.match(headRe);
    if (h) {
      if (cur) out.push(cur);
      cur = {
        code: h[1],
        from_station: h[2],
        to_station: h[3],
        depart: h[4],
        arrive: h[5],
        duration_min: Number(h[6]) * 60 + Number(h[7]),
        seats: [],
      };
      continue;
    }
    if (!cur) continue;
    const s = line.match(seatRe);
    if (s) {
      cur.seats.push({
        name: s[1].trim(),
        status: s[2].trim(),
        price: Number(s[3]),
      });
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 查余票；未配置、无数据或失败时返回空数组（由调用方回退估算） */
export async function queryTickets(
  from: string,
  to: string,
  date: string,
): Promise<TrainTicket[]> {
  if (!MCP_URL) return [];
  const key = `${from}|${to}|${date}`;
  const hit = TICKET_CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.list;

  try {
    await ensureSession();
    const res = await rpc("tools/call", {
      name: "get-tickets",
      arguments: { date, fromStation: from, toStation: to },
    });
    if (res?.error) throw new Error(res.error.message || "MCP 调用失败");
    const content = (res?.result?.content || []) as any[];
    const text = content.map((c) => c?.text || "").join("\n");
    const list = res?.result?.isError ? [] : parseTickets(text);
    if (list.length) TICKET_CACHE.set(key, { at: Date.now(), list });
    return list;
  } catch {
    // 会话可能过期：清空后下次重连
    sessionId = "";
    return [];
  }
}
