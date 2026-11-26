/** 前端共享常量：扰动选项、事件元信息、日程配色 */

/** 扰动选项（与后端 generate_disruptions 对齐） */
export const DISRUPTION_OPTIONS = [
  { label: "不模拟扰动", value: "" },
  { label: "突发降雨（室外景点不可游）", value: "rain" },
  { label: "景点临时闭馆", value: "museum_closed" },
  { label: "交通拥堵延误 40 分钟", value: "traffic_jam" },
  { label: "老人走不动（跳过高台阶）", value: "elder_tired" },
  { label: "热门景点排队超时", value: "queue" },
];

/** 事件 → 中文标签 / 主题色（hex，供自定义时间线渲染） */
export const EVENT_META: Record<string, { label: string; color: string }> = {
  run_started: { label: "任务启动", color: "#6366f1" },
  start: { label: "开始", color: "#6366f1" },
  plan: { label: "需求理解", color: "#06b6d4" },
  solve: { label: "生成行程", color: "#10b981" },
  verify: { label: "约束校验", color: "#14b8a6" },
  stress: { label: "韧性压测", color: "#f59e0b" },
  replan: { label: "扰动重规划", color: "#8b5cf6" },
  proposal: { label: "权限审批", color: "#ef4444" },
  assistant: { label: "Agent 回复", color: "#38bdf8" },
  done: { label: "执行完成", color: "#94a3b8" },
  metrics: { label: "汇总指标", color: "#6366f1" },
  run_completed: { label: "运行结束", color: "#10b981" },
  run_failed: { label: "运行失败", color: "#ef4444" },
};

export const eventLabel = (e: string) => EVENT_META[e]?.label ?? e;
export const eventColor = (e: string) => EVENT_META[e]?.color ?? "#94a3b8";

/** 每日主题色（地图标记 + 行程卡），按天循环取色 */
export const DAY_COLORS = [
  "#4f46e5", // indigo
  "#06b6d4", // cyan
  "#10b981", // emerald
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#14b8a6", // teal
];
export const dayColor = (day: number) => DAY_COLORS[(Math.max(1, day) - 1) % DAY_COLORS.length];

/** 室内外 → 中文标签 */
export const indoorLabel = (v?: string) =>
  v === "indoor" ? "室内" : v === "outdoor" ? "室外" : v === "mixed" ? "混合" : "—";

/* ─────────────── 旅行偏好（AI 规划视图用） ─────────────── */
/** 出行人群选项 */
export const GROUP_OPTIONS = ["老人", "小孩", "青年", "情侣", "朋友"];
/** 出行方式选项（AI 偏好与城际交通共用；value 与后端 TransportMode 一致） */
export const TRANSPORT_MODE_OPTIONS = [
  { label: "飞机", value: "plane", icon: "✈️", hint: "速度快，适合长距离" },
  { label: "高铁", value: "train", icon: "🚄", hint: "准点稳定，市区到市区" },
  { label: "自驾", value: "drive", icon: "🚗", hint: "灵活自由，适合周边" },
] as const;
/** 出行方式 → 中文标签（未选择时返回空串） */
export function transportModeLabel(v?: string | null): string {
  return TRANSPORT_MODE_OPTIONS.find((o) => o.value === v)?.label ?? "";
}
/** 行程节奏选项 */
export const PACE_OPTIONS = [
  { label: "宽松（多休息）", value: "relaxed" },
  { label: "适中", value: "moderate" },
  { label: "紧凑（多打卡）", value: "tight" },
] as const;
/** 避开项选项 */
export const AVOID_OPTIONS = ["高台阶", "纯室外", "需预约", "高消费"];
/** 各城市最热门景点（离线快照无评分时按此顺序推荐前 9 个；在线有评分时评分优先） */
export const HOT_SCENIC_BY_CITY: Record<string, string[]> = {
  苏州: ["拙政园", "苏州博物馆", "平江路", "虎丘", "山塘街", "留园", "寒山寺", "狮子林", "周庄古镇"],
  杭州: ["西湖", "灵隐寺", "浙江省博物馆", "雷峰塔", "西溪湿地", "宋城", "中国茶叶博物馆", "飞来峰", "河坊街"],
  南京: ["中山陵", "夫子庙", "南京博物院", "总统府", "明孝陵", "老门东", "牛首山", "玄武湖", "鸡鸣寺"],
};

/** 地图高亮分类（点一次高亮，再点一次取消；不再设「全部」按钮） */
export const CATEGORY_FILTERS = ["景点", "酒店", "美食", "购物", "机场", "火车站"];
/** 展示名 → 内部 POI 分类（美食在内部叫餐厅） */
export const CATEGORY_TO_POI: Record<string, string> = { 美食: "餐厅" };
/** 分类图标（无图片时的封面占位） */
export const CATEGORY_ICON: Record<string, string> = {
  景点: "🏞️",
  酒店: "🏨",
  餐厅: "🍜",
  美食: "🍜",
  购物: "🛍️",
  机场: "✈️",
  火车站: "🚄",
};
