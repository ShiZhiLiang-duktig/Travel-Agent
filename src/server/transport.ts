/**
 * 城际交通规划：出发城市 → 目的地，给出飞机 / 高铁 / 自驾的时长、费用估算与推荐。
 *
 * 数据口径：
 *   - 距离 = 两城市行政区中心点之间的直线距离（高德 district，失败退回 geocode，带进程内缓存）
 *   - 高铁：传了出行日期且配置了 RAILWAY_MCP_URL 时，用 12306 实时车次的最快一趟校正时长与二等座票价
 *   - 飞机：可选 FLIGHT_MCP_URL 查询实时班次/余票，未配置或调用失败时明确标注原因，不伪造数据
 *   - 自驾：里程 = 直线 × 1.25 绕行系数；费用拆成「油费 + 高速通行费」，并给出整车与人均两套口径
 *   - 其余为经验估算（高铁按 250km/h、飞机按 700km/h、自驾按 85km/h 并含候车/值机/休息）
 *   - availability：按三种方式给出班次/余票状态，前端直接展示所选方式的查询结果
 */
import { amapDistrict, amapGeocode } from "./amap.js";
import { isRailwayConfigured, queryTickets, type TrainTicket } from "./railway.js";
import { isFlightConfigured, queryFlights, type FlightQueryResult, type FlightTicket } from "./flight.js";

export type TransportMode = "plane" | "train" | "drive";

/** 自驾费用拆分：油费 + 高速通行费，按同车人数分摊 */
export interface DriveCostBreakdown {
  /** 实际行驶里程（km，含绕行系数） */
  km: number;
  /** 高速路段里程（km，估算） */
  highway_km: number;
  /** 燃油费（元，整车） */
  fuel: number;
  /** 高速通行费（元，整车） */
  toll: number;
  /** 整车合计（元） */
  total: number;
  /** 同车人数（用于分摊） */
  travelers: number;
  /** 人均（元） */
  per_person: number;
  /** 计算口径说明，前端直接展示 */
  basis: string;
}

export interface TransportOption {
  mode: TransportMode;
  label: string;
  /** 全程预计小时数（含候车 / 值机 / 休息） */
  hours: number;
  /** 单人预计费用（元） */
  cost: number;
  note: string;
  /** 自驾才有：油费 / 过路费拆分 */
  cost_breakdown?: DriveCostBreakdown;
}

/** 班次/余票状态：有票 / 余票紧张 / 无票 / 无需购票 / 未接入或查不到 */
export type AvailabilityStatus =
  | "available"
  | "limited"
  | "sold_out"
  | "not_required"
  | "unavailable";

/** 一条可展示的班次（高铁车次 / 航班） */
export interface AvailabilityEntry {
  label: string;
  depart: string;
  arrive: string;
  duration_min?: number;
  price?: number;
  /** 席别 / 舱位 */
  seat: string;
  /** 余票状态原文，如「有票」「剩余 6 张票」 */
  status: string;
  /** 补充信息（机场、机型、准点率等），前端小字展示 */
  sub?: string;
}

export interface ModeAvailability {
  mode: TransportMode;
  status: AvailabilityStatus;
  /** 一句话结论，直接展示给用户 */
  headline: string;
  /** 补充说明（数据源、缓存、票价口径等） */
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
  /** 12306 实时车次（仅在配置了 MCP 且查到数据时返回） */
  realtime?: {
    source: "12306";
    date: string;
    /** 实际用于查询的城市（省级出发地会代查省会） */
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

interface Center {
  lat: number;
  lng: number;
}

/** 城市中心点缓存：地理编码结果基本不变，避免重复消耗高德 QPS */
const CENTER_CACHE = new Map<string, Center | null>();

function parseLocation(raw: string): Center | null {
  const [lngS, latS] = String(raw || "").split(",");
  const lng = Number(lngS);
  const lat = Number(latS);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !lng || !lat) return null;
  return { lng, lat };
}

/** 取城市中心坐标（优先行政区中心，失败再退回地理编码；都失败返回 null） */
async function cityCenter(city: string): Promise<Center | null> {
  if (CENTER_CACHE.has(city)) return CENTER_CACHE.get(city)!;
  let center: Center | null = null;
  try {
    const j = await amapDistrict(city);
    center = parseLocation(String(j?.districts?.[0]?.center || ""));
  } catch {
    center = null;
  }
  if (!center) {
    try {
      const j = await amapGeocode(city);
      center = parseLocation(String(j?.geocodes?.[0]?.location || ""));
    } catch {
      center = null;
    }
  }
  CENTER_CACHE.set(city, center);
  return center;
}

/** 两点球面距离（km） */
function haversineKm(a: Center, b: Center): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 取整到 0.5 小时 / 5 元，避免出现 4.333 小时这种伪精确 */
const halfHour = (h: number) => Math.round(h * 2) / 2;
const round5 = (n: number) => Math.round(n / 5) * 5;

/**
 * 自驾费用口径（家用 5 座轿车，2026 年国内常见水平）：
 *   油耗 7.5 L/100km × 油价 7.6 元/L ≈ 0.57 元/km
 *   高速通行费 0.45 元/km（一类客车），城市/国道路段不计费
 * 只算油费与过路费，不含停车、门票、违章等浮动支出。
 */
const FUEL_PER_KM = (7.5 / 100) * 7.6;
const TOLL_PER_KM = 0.45;

/** 长途高速占比更高，短途会走更多城市道路 */
function highwayShare(km: number): number {
  if (km <= 40) return 0.35;
  if (km <= 100) return 0.7;
  if (km <= 300) return 0.82;
  return 0.88;
}

function driveCost(km: number, travelers: number): DriveCostBreakdown {
  const share = highwayShare(km);
  const highwayKm = Math.round(km * share);
  const fuel = round5(km * FUEL_PER_KM);
  const toll = round5(highwayKm * TOLL_PER_KM);
  const total = fuel + toll;
  const people = Math.max(1, Math.min(7, Math.round(travelers) || 2));
  return {
    km: Math.round(km),
    highway_km: highwayKm,
    fuel,
    toll,
    total,
    travelers: people,
    per_person: round5(total / people),
    basis: `油耗按 7.5L/100km、油价 7.6 元/L，高速按 ${TOLL_PER_KM} 元/km；不含停车与门票`,
  };
}

/** 省份 → 省会（12306 按城市查询；直辖市/特别行政区用自身） */
const PROVINCE_CAPITAL: Record<string, string> = {
  北京: "北京", 上海: "上海", 天津: "天津", 重庆: "重庆",
  河北: "石家庄", 山西: "太原", 内蒙古: "呼和浩特", 辽宁: "沈阳", 吉林: "长春",
  黑龙江: "哈尔滨", 江苏: "南京", 浙江: "杭州", 安徽: "合肥", 福建: "福州",
  江西: "南昌", 山东: "济南", 河南: "郑州", 湖北: "武汉", 湖南: "长沙",
  广东: "广州", 广西: "南宁", 海南: "海口", 四川: "成都", 贵州: "贵阳",
  云南: "昆明", 西藏: "拉萨", 陕西: "西安", 甘肃: "兰州", 青海: "西宁",
  宁夏: "银川", 新疆: "乌鲁木齐", 台湾: "台北", 香港: "香港", 澳门: "澳门",
};

/** 把省级名称转成 12306 可查询的城市：省会优先，未知名称原样返回 */
async function railCity(name: string): Promise<string> {
  if (PROVINCE_CAPITAL[name]) return PROVINCE_CAPITAL[name];
  return name;
}

/** 余票状态 → 是否可售（12306 / 航班 MCP 状态文案不完全统一，做宽松匹配） */
function hasSeat(status: string): boolean {
  return /有票|充足|剩余\s*\d+\s*张|余票/.test(status) && !/无票|售罄/.test(status);
}

function limitedSeat(status: string): boolean {
  const m = status.match(/剩余\s*(\d+)\s*张/);
  return !!m && Number(m[1]) <= 10;
}

/** 高铁班次/余票：来自 12306 MCP 的真实查询结果 */
function trainAvailability(
  tickets: TrainTicket[],
  date?: string,
): ModeAvailability {
  const now = new Date().toISOString();
  const base = { mode: "train" as const, checked_at: now, source: "12306 实时余票" };
  if (!date)
    return {
      ...base,
      status: "unavailable",
      headline: "选好出发日期后可查 12306 车次与余票",
      detail: "当前未选择出行日期，时长与票价为估算。",
      source: "未查询",
    };
  if (!isRailwayConfigured())
    return {
      ...base,
      status: "unavailable",
      headline: "未接入 12306 实时余票",
      detail: "服务端未配置 RAILWAY_MCP_URL，当前展示的为估算时长与票价。",
      source: "未配置",
    };
  if (!tickets.length)
    return {
      ...base,
      status: "unavailable",
      headline: "12306 暂未返回直达车次",
      detail: "可能无直达车次或查询失败，建议改查中转城市，票价时长按估算参考。",
      source: "12306 实时余票",
    };

  const daytime = tickets.filter((t) => t.depart >= "06:00");
  const list = (daytime.length ? daytime : tickets).slice(0, 5);
  const entries: AvailabilityEntry[] = list.map((t) => {
    const seat = t.seats.find((s) => s.name.includes("二等座")) || t.seats[0];
    return {
      label: t.code,
      depart: t.depart,
      arrive: t.arrive,
      duration_min: t.duration_min,
      price: seat?.price,
      seat: seat?.name || "二等座",
      status: seat?.status || "以实际为准",
    };
  });
  const positive = tickets.filter((t) => t.seats.some((s) => hasSeat(s.status))).length;
  const tight = tickets.some((t) =>
    t.seats.some((s) => limitedSeat(s.status)),
  );
  const status: AvailabilityStatus =
    positive === 0
      ? "sold_out"
      : positive <= 2 || positive * 2 < tickets.length
        ? "limited"
        : "available";
  const headline =
    positive === 0
      ? `查到 ${tickets.length} 趟车次，二等座均未显示余票`
      : `查到 ${tickets.length} 趟车次，其中 ${positive} 趟二等座有票`;
  return {
    ...base,
    status,
    headline,
    detail: `日期 ${date}；展示前 ${entries.length} 趟白天车次${tight ? "，部分车次余票紧张" : ""}，余票 10 分钟缓存，下单前以 12306 为准。`,
    entries,
  };
}

/** 白天航班优先（06:00–22:00），避免用红眼航班的最低价/最短耗时误导用户 */
function daytimeFirst(flights: FlightTicket[]): FlightTicket[] {
  const day = flights.filter((f) => f.depart >= "06:00" && f.depart < "22:00");
  return day.length ? day : flights;
}

/** 飞机班次/余票：航班 MCP，含票价与余票时给结论，只有时刻表时如实说明 */
function planeAvailability(
  flights: FlightTicket[],
  date?: string,
  info?: FlightQueryResult | null,
): ModeAvailability {
  const now = new Date().toISOString();
  const base = { mode: "plane" as const, checked_at: now, source: "航班数据源" };
  if (!date)
    return {
      ...base,
      status: "unavailable",
      headline: "选好出发日期后可查询航班班次与余票",
      detail: "当前未选择出行日期，时长与票价为估算。",
      source: "未查询",
    };
  if (!info?.configured)
    return {
      ...base,
      status: "unavailable",
      headline: "暂未接入航班数据源",
      detail:
        "航班没有 12306 那样的统一公开接口，需要在服务端 .env 配置 FLIGHT_MCP_URL（魔搭托管的航班 MCP，如飞常准 variflight）才能查到真实班次与票价；高铁能查到是因为已配置 RAILWAY_MCP_URL。当前舱位价格与时长为估算，请在航司/OTA 核对。",
      source: "未配置",
    };
  if (info.error && !flights.length) {
    const isConfig = /专属服务 ID|http\(s\)|缺少/.test(info.error);
    return {
      ...base,
      status: "unavailable",
      headline: isConfig ? "航班数据源地址不完整" : "航班数据源调用失败",
      detail: `已配置航班数据源，但本次查询失败：${info.error}。可稍后重试，或检查 FLIGHT_MCP_URL 是否完整、是否过期，以及参数格式（城市名 / 三字码）是否匹配。票价与时长为估算。`,
      source: isConfig ? "配置有误" : "调用失败",
    };
  }
  if (!flights.length)
    return {
      ...base,
      status: "unavailable",
      headline: "航班数据源未返回可售航班",
      detail: "可能当天无可售航班或参数不被识别，票价与时长为估算。",
      source: "航班数据源",
    };
  const entries: AvailabilityEntry[] = flights.slice(0, 5).map((f) => {
    const subParts = [
      f.from_name && f.to_name ? `${f.from_name}${f.from_terminal || ""} → ${f.to_name}${f.to_terminal || ""}` : "",
      f.aircraft ? `机型 ${f.aircraft}` : "",
      f.ontime ? `准点率 ${f.ontime}` : "",
    ].filter(Boolean);
    return {
      label: f.code,
      depart: f.depart,
      arrive: f.arrive,
      duration_min: f.duration_min,
      price: f.price,
      seat: f.base_price !== undefined && f.tax ? "经济舱（含税）" : "经济舱",
      status: f.status,
      ...(subParts.length ? { sub: subParts.join(" · ") } : {}),
    };
  });

  const withSeats = flights.filter((f) => f.seats !== undefined);
  const positive = withSeats.filter((f) => (f.seats as number) > 0).length;
  const cheapest = daytimeFirst(flights)
    .filter((f) => f.price !== undefined)
    .sort((a, b) => (a.price as number) - (b.price as number))[0];

  // 有仓位余票数据时按余票判状态；只有时刻表时说明「有班次、余票需确认」
  const status: AvailabilityStatus = !withSeats.length
    ? "available"
    : positive === 0
      ? "sold_out"
      : positive <= 2 || withSeats.some((f) => (f.seats as number) <= 3)
        ? "limited"
        : "available";

  const priceText = cheapest
    ? `，最低含税 ¥${cheapest.price}（${cheapest.code} ${cheapest.depart} 起飞）`
    : "";
  const seatText = withSeats.length ? `，其中 ${positive} 个有余票` : "";
  const toolName = info.tool || "";
  const toolLabel = /price|fare|cabin|ticket/i.test(toolName)
    ? "航班数据源（含票价/余票）"
    : "航班数据源（时刻表）";

  return {
    ...base,
    status,
    headline: `查到 ${flights.length} 个航班${priceText}${seatText}`,
    detail:
      `日期 ${date}；展示最早起飞的 ${entries.length} 个航班，价格为经济舱含税总价（票面价 + 机建燃油）。` +
      (withSeats.length
        ? "余票数为数据源返回的实时可售座位，出票时以航司为准。"
        : "该数据源只返回时刻表，不含票价与余票，请在航司 / OTA 核对。"),
    source: `${toolLabel}${toolName ? ` · ${toolName}` : ""}`,
    entries,
  };
}

/** 自驾：不存在班次与余票，给出明确结论与路程/费用估算 */
function driveAvailability(
  distance: number,
  hours: number,
  cost: DriveCostBreakdown,
): ModeAvailability {
  return {
    mode: "drive",
    status: "not_required",
    headline: "自驾无需购票，也没有班次与余票限制",
    detail:
      `全程约 ${distance} 公里（含绕行），预计 ${halfHour(hours)} 小时（含休息），全天可出发；` +
      `油费约 ¥${cost.fuel} + 高速通行费约 ¥${cost.toll} = 整车约 ¥${cost.total}。${cost.basis}。`,
    source: "路线估算",
    checked_at: new Date().toISOString(),
    entries: [
      {
        label: "全程可出发",
        depart: `${cost.km} km`,
        arrive: "门到门",
        seat: "—",
        status: "无需购票",
      },
    ],
  };
}

export async function planTransport(
  from: string,
  to: string,
  date?: string,
  travelers = 2,
): Promise<TransportPlan> {
  const a = await cityCenter(from);
  const b = await cityCenter(to);
  if (!a || !b) {
    throw new Error(`无法定位「${!a ? from : to}」，请重新选择城市`);
  }
  const distance = Math.max(1, Math.round(haversineKm(a, b)));

  // 自驾实际里程约为直线的 1.25 倍（绕路系数）
  const driveKm = distance * 1.25;
  const driveHours = driveKm / 85 + 0.4;
  const trainHours = distance / 250 + 1;
  const planeHours = distance / 700 + 3;

  // 高铁：能用 12306 实时车次时，用最快一趟的历时与二等座票价校正
  // 省级出发地（如「江苏」）12306 无法直接查询，按省会/首个下辖市代查
  let railFrom = from;
  let railTo = to;
  let tickets: TrainTicket[] = [];
  let flights: FlightTicket[] = [];
  let flightInfo: FlightQueryResult | null = null;
  if (date && distance > 30 && (isRailwayConfigured() || isFlightConfigured())) {
    [railFrom, railTo] = await Promise.all([railCity(from), railCity(to)]);
    if (isRailwayConfigured()) tickets = await queryTickets(railFrom, railTo, date);
    if (isFlightConfigured()) {
      // 航班按真实城市查（城市 → 机场三字码由 flight.ts 处理），只有省级旧数据才退到省会
      const flightFrom = PROVINCE_CAPITAL[from] || from;
      const flightTo = PROVINCE_CAPITAL[to] || to;
      flightInfo = await queryFlights(flightFrom, flightTo, date);
      flights = flightInfo.list;
    }
  }
  const fastest: TrainTicket | null = tickets.length
    ? tickets.reduce((x, y) => (y.duration_min < x.duration_min ? y : x))
    : null;
  const fastestSecond = fastest?.seats.find((s) => s.name.includes("二等座"));

  // 自驾费用拆成油费 + 高速通行费，并给出整车/人均两套口径
  const drive = driveCost(driveKm, travelers);

  // 航班有实时数据时，用真实最低含税价与最快航班历时校正「飞机」的估算值（白天航班优先）
  const dayFlights = daytimeFirst(flights);
  const cheapestFlight =
    dayFlights
      .filter((f) => f.price !== undefined)
      .sort((a, b) => (a.price as number) - (b.price as number))[0] || null;
  const fastestFlight =
    dayFlights
      .filter((f) => f.duration_min)
      .sort((a, b) => (a.duration_min as number) - (b.duration_min as number))[0] || null;

  const options: TransportOption[] = [
    {
      mode: "drive",
      label: "自驾",
      hours: halfHour(driveHours),
      cost: drive.per_person,
      note: `${drive.km} km 门到门（含绕行）`,
      cost_breakdown: drive,
    },
    {
      mode: "train",
      label: "高铁",
      hours: fastest
        ? halfHour(fastest.duration_min / 60 + 0.75)
        : halfHour(trainHours),
      cost: fastestSecond
        ? round5(fastestSecond.price)
        : round5(distance * 0.45 + 20),
      note: fastest
        ? `12306 最快 ${fastest.code} ${fastest.depart}–${fastest.arrive}，二等座${fastestSecond ? `${fastestSecond.status} ¥${fastestSecond.price}` : "票价以实际为准"}（含进站候车）`
        : "含进站候车，按二等座票价估算",
    },
    {
      mode: "plane",
      label: "飞机",
      hours: fastestFlight
        ? halfHour((fastestFlight.duration_min as number) / 60 + 2.5)
        : halfHour(planeHours),
      cost: cheapestFlight ? (cheapestFlight.price as number) : round5(350 + distance * 0.35),
      note: cheapestFlight
        ? `${cheapestFlight.code} ${cheapestFlight.depart} 起，含税 ¥${cheapestFlight.price}，含往返机场与值机安检`
        : "含往返机场与值机安检时间（票价待接入数据源）",
    },
  ];

  // 推荐逻辑：短途自驾更灵活；其余按全程耗时选更快的（高铁 vs 飞机）
  const recommended: TransportMode =
    distance <= 120 ? "drive" : planeHours < trainHours ? "plane" : "train";

  // 推荐项排在最前，方便前端直接展示
  const ordered = [
    ...options.filter((o) => o.mode === recommended),
    ...options.filter((o) => o.mode !== recommended),
  ];
  const best = ordered[0];
  const others = ordered
    .slice(1)
    .map((o) =>
      o.cost_breakdown
        ? `自驾约 ${o.hours} 小时（油费 ¥${o.cost_breakdown.fuel} + 高速 ¥${o.cost_breakdown.toll} = 整车 ¥${o.cost_breakdown.total}）`
        : `${o.label}约 ${o.hours} 小时`,
    )
    .join("，");
  const bestCost = best.cost_breakdown
    ? `整车约 ¥${best.cost_breakdown.total}（油费 ¥${best.cost_breakdown.fuel} + 高速 ¥${best.cost_breakdown.toll}）`
    : `约 ¥${best.cost}/人`;
  const summary = `${from} → ${to} 直线约 ${distance} 公里，推荐${best.label}：预计 ${best.hours} 小时、${bestCost}；${others}。`;

  return {
    from,
    to,
    distance_km: distance,
    recommended,
    options: ordered,
    summary,
    availability: {
      train: trainAvailability(tickets, date),
      plane: planeAvailability(flights, date, flightInfo),
      drive: driveAvailability(driveKm, driveHours, drive),
    },
    ...(tickets.length
      ? {
          realtime: {
            source: "12306" as const,
            date: date!,
            query_from: railFrom,
            query_to: railTo,
            // 列表按发车时间取前 3 趟，优先白天车次（过滤凌晨 0–6 点的过路车）
            trains: (tickets.filter((t) => t.depart >= "06:00").length
              ? tickets.filter((t) => t.depart >= "06:00")
              : tickets
            )
              .slice(0, 3)
              .map((t) => {
              const second = t.seats.find((s) => s.name.includes("二等座"));
              return {
                code: t.code,
                from_station: t.from_station,
                to_station: t.to_station,
                depart: t.depart,
                arrive: t.arrive,
                duration_min: t.duration_min,
                second_price: second?.price,
                second_status: second?.status,
              };
            }),
          },
        }
      : {}),
  };
}
