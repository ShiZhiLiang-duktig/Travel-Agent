/**
 * 数据模型 —— 整个系统的"共同语言"。
 *
 * 设计要点：所有 POI / 行程项都带结构化属性（步行距离、台阶数、室内外、单价），
 * 这样"约束可验证"才能成立——验证器断言的是这些字段，而不是让 LLM 自己判断。
 *
 * 这是 Python 版 src/core/models.py 的 TS 重写，字段与语义保持一致。
 */

/** 室内外属性。 */
export type Indoor = "indoor" | "outdoor" | "mixed";

/** 扰动对行程项的影响类型。 */
export type Impact = "closure" | "weather" | "delay" | "mobility" | "crowd";

/** 景点/餐厅/交通枢纽的结构化数据。所有字段都来自可信数据源快照。 */
export interface POI {
  id: string;
  name: string;
  city: string;
  category: string; // 景点 / 餐厅 / 车站 / 酒店
  lat: number;
  lng: number;
  visit_minutes: number; // 建议游玩时长
  walking_minutes: number; // 从上一站步行时间（近似）
  stairs: number; // 台阶数（老人无障碍关键）
  indoor: Indoor;
  price_per_person: number;
  needs_reservation: boolean;
  source: string; // 溯源字段：幻觉检测用
  open_hours: string;
  mobility_note: string; // 如"全程石板路，轮椅困难"
}

/** 同行人画像。年龄和行动能力直接决定体力预算与硬约束。 */
export interface Traveler {
  name: string;
  age: number;
  mobility: string; // normal / slow / wheelchair / child
  needs_nap: boolean;
  dietary: string;
}

/** 从用户需求解析出的硬约束集合。Verifier 逐条断言这些字段。 */
export interface Constraints {
  budget_total: number; // 预算硬上限（元）
  max_walking_minutes_per_day: number; // 每天步行上限
  max_stairs_per_item: number; // 单个景点台阶上限
  max_items_per_day: number; // 每天景点数上限（防过度打包）
  require_afternoon_indoor: boolean; // 下午必须室内（带老人小孩）
  nap_required: boolean; // 是否需要午休时段
  avoid_outdoor_if_rain: boolean; // 下雨避开室外
  must_visit: string[];
  travelers: Traveler[];
}

/** 行程中的一个条目：某个时间段的某个 POI。 */
export class ItineraryItem {
  poi: POI;
  day: number;
  start_minute: number; // 从 00:00 起的分钟数，如 540 = 09:00
  duration_minutes: number;
  is_backup: boolean; // 是否为备用方案
  // 由求解器注入，用于预算核算（单价 × 人数）
  poi_source_travelers: Traveler[];

  constructor(opts: {
    poi: POI;
    day: number;
    start_minute: number;
    duration_minutes: number;
    is_backup?: boolean;
    poi_source_travelers?: Traveler[];
  }) {
    this.poi = opts.poi;
    this.day = opts.day;
    this.start_minute = opts.start_minute;
    this.duration_minutes = opts.duration_minutes;
    this.is_backup = opts.is_backup ?? false;
    this.poi_source_travelers = opts.poi_source_travelers ?? [];
  }

  get end_minute(): number {
    return this.start_minute + this.duration_minutes;
  }

  get cost(): number {
    return this.poi.price_per_person * Math.max(this.poi_source_travelers.length, 1);
  }

  to_dict() {
    return {
      day: this.day,
      start: `${String(Math.floor(this.start_minute / 60)).padStart(2, "0")}:${String(this.start_minute % 60).padStart(2, "0")}`,
      end: `${String(Math.floor(this.end_minute / 60)).padStart(2, "0")}:${String(this.end_minute % 60).padStart(2, "0")}`,
      poi: this.poi.name,
      city: this.poi.city,
      walking_min: this.poi.walking_minutes,
      stairs: this.poi.stairs,
      indoor: this.poi.indoor,
      cost: Math.round(this.cost * 100) / 100,
      is_backup: this.is_backup,
      source: this.poi.source,
    };
  }
}

/** 完整行程 = 有序的行程项列表 + 关联的约束。 */
export class Itinerary {
  items: ItineraryItem[];
  constraints: Constraints;
  days: number;
  label: string;

  constructor(opts: {
    items: ItineraryItem[];
    constraints: Constraints;
    days?: number;
    label?: string;
  }) {
    this.items = opts.items;
    this.constraints = opts.constraints;
    this.days = opts.days ?? 3;
    this.label = opts.label ?? "baseline";
  }

  total_cost(): number {
    return this.items.filter((i) => !i.is_backup).reduce((s, i) => s + i.cost, 0);
  }

  items_for_day(day: number): ItineraryItem[] {
    return this.items
      .filter((i) => i.day === day && !i.is_backup)
      .sort((a, b) => a.start_minute - b.start_minute);
  }

  to_dict() {
    return {
      label: this.label,
      days: this.days,
      total_cost: Math.round(this.total_cost() * 100) / 100,
      items: this.items.map((i) => i.to_dict()),
    };
  }

  /** 深拷贝：item 是新对象（便于扰动时修改 start_minute），poi 共享引用（不可变）。 */
  clone(label?: string): Itinerary {
    return new Itinerary({
      items: this.items.map(
        (i) =>
          new ItineraryItem({
            poi: i.poi,
            day: i.day,
            start_minute: i.start_minute,
            duration_minutes: i.duration_minutes,
            is_backup: i.is_backup,
            poi_source_travelers: i.poi_source_travelers,
          })
      ),
      constraints: this.constraints,
      days: this.days,
      label: label ?? this.label,
    });
  }
}

/** 扰动事件：压力测试和重规划的输入。 */
export interface Disruption {
  id: string;
  kind: Impact;
  description: string;
  target_poi_ids: string[];
  target_day: number | null;
  delay_minutes: number;
  probability: number;
}

/** 单个约束的断言结果。 */
export interface ValidationResult {
  rule: string;
  passed: boolean;
  detail: string;
}

/** 压力测试结果：注入扰动后行程是否仍可行。 */
export interface StressResult {
  disruption: Disruption;
  survived: boolean;
  reason: string;
  modified_items: string[];
}

/** 全链路 trace 的最小单元。可回放、可审计。 */
export interface TraceEvent {
  step: string;
  agent: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

// ===== 工厂函数：保持与 Python dataclass 类似的构造体验 =====

export function makePOI(p: Partial<POI> & { id: string; name: string; city: string; category: string; lat: number; lng: number; visit_minutes: number; walking_minutes: number }): POI {
  return {
    stairs: 0,
    indoor: "outdoor",
    price_per_person: 0,
    needs_reservation: false,
    source: "local_snapshot",
    open_hours: "09:00-17:00",
    mobility_note: "",
    ...p,
  };
}

export function makeTraveler(t: Partial<Traveler> & { name: string; age: number }): Traveler {
  return { mobility: "normal", needs_nap: false, dietary: "", ...t };
}

export function makeConstraints(c: Partial<Constraints> & { budget_total: number }): Constraints {
  return {
    max_walking_minutes_per_day: 90,
    max_stairs_per_item: 20,
    max_items_per_day: 4,
    require_afternoon_indoor: false,
    nap_required: false,
    avoid_outdoor_if_rain: true,
    must_visit: [],
    travelers: [],
    ...c,
  };
}

export function makeDisruption(d: Partial<Disruption> & { id: string; kind: Impact; description: string }): Disruption {
  return {
    target_poi_ids: [],
    target_day: null,
    delay_minutes: 0,
    probability: 1.0,
    ...d,
  };
}
