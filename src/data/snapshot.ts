/**
 * 本地数据快照 —— Demo 默认数据源，避免面试现场 API Key 失效/限流。
 *
 * 覆盖 3 城市：苏州 / 杭州 / 南京，每城 10+ 景点 + 2-3 餐厅 + 1-2 酒店。
 * Python 版 src/data/snapshot.py 的 TS 重写，数据完全一致。
 */
import { makePOI, makeConstraints, makeTraveler, type POI, type Constraints } from "../core/models.js";

// 苏州
const _SUZHOU: POI[] = [
  makePOI({ id: "s1", name: "拙政园", city: "苏州", category: "景点", lat: 31.324, lng: 120.628, visit_minutes: 120, walking_minutes: 25, stairs: 6, indoor: "outdoor", price_per_person: 80, needs_reservation: true, open_hours: "07:30-17:30", mobility_note: "园林有台阶与窄桥，轮椅需绕行" }),
  makePOI({ id: "s2", name: "苏州博物馆", city: "苏州", category: "景点", lat: 31.322, lng: 120.626, visit_minutes: 90, walking_minutes: 10, stairs: 0, indoor: "indoor", price_per_person: 0, needs_reservation: true, open_hours: "09:00-17:00", mobility_note: "全馆无障碍" }),
  makePOI({ id: "s3", name: "平江路", city: "苏州", category: "景点", lat: 31.321, lng: 120.632, visit_minutes: 90, walking_minutes: 20, stairs: 0, indoor: "outdoor", price_per_person: 0, open_hours: "全天", mobility_note: "石板路，雨天湿滑" }),
  makePOI({ id: "s4", name: "诚品书店", city: "苏州", category: "景点", lat: 31.318, lng: 120.678, visit_minutes: 90, walking_minutes: 15, stairs: 0, indoor: "indoor", price_per_person: 0, open_hours: "10:00-22:00", mobility_note: "全店无障碍，雨天优选" }),
  makePOI({ id: "s5", name: "虎丘", city: "苏州", category: "景点", lat: 31.333, lng: 120.575, visit_minutes: 150, walking_minutes: 35, stairs: 40, indoor: "outdoor", price_per_person: 70, open_hours: "07:30-17:00", mobility_note: "台阶多，坡度大，老人不宜" }),
  makePOI({ id: "s6", name: "山塘街", city: "苏州", category: "景点", lat: 31.311, lng: 120.601, visit_minutes: 90, walking_minutes: 25, stairs: 4, indoor: "mixed", price_per_person: 0, open_hours: "全天", mobility_note: "部分路段石板路" }),
  makePOI({ id: "s7", name: "网师园", city: "苏州", category: "景点", lat: 31.320, lng: 120.632, visit_minutes: 60, walking_minutes: 12, stairs: 5, indoor: "outdoor", price_per_person: 40, open_hours: "07:30-17:00" }),
  makePOI({ id: "s8", name: "狮子林", city: "苏州", category: "景点", lat: 31.324, lng: 120.629, visit_minutes: 75, walking_minutes: 15, stairs: 3, indoor: "outdoor", price_per_person: 50, mobility_note: "假山多，路径曲折" }),
  makePOI({ id: "s9", name: "沧浪亭", city: "苏州", category: "景点", lat: 31.318, lng: 120.625, visit_minutes: 60, walking_minutes: 12, stairs: 2, indoor: "outdoor", price_per_person: 25 }),
  makePOI({ id: "s10", name: "周庄古镇", city: "苏州", category: "景点", lat: 31.117, lng: 120.833, visit_minutes: 180, walking_minutes: 40, stairs: 0, indoor: "outdoor", price_per_person: 100, mobility_note: "古镇石板路多" }),
  makePOI({ id: "sr1", name: "松鹤楼", city: "苏州", category: "餐厅", lat: 31.320, lng: 120.628, visit_minutes: 60, walking_minutes: 8, stairs: 0, indoor: "indoor", price_per_person: 120, mobility_note: "无障碍通道" }),
  makePOI({ id: "sr2", name: "得月楼", city: "苏州", category: "餐厅", lat: 31.322, lng: 120.626, visit_minutes: 60, walking_minutes: 10, stairs: 2, indoor: "indoor", price_per_person: 150 }),
  makePOI({ id: "sh1", name: "苏州洲际酒店", city: "苏州", category: "酒店", lat: 31.303, lng: 120.622, visit_minutes: 1440, walking_minutes: 0, stairs: 0, indoor: "indoor", price_per_person: 450, mobility_note: "全馆无障碍，含加床" }),
];

// 杭州
const _HANGZHOU: POI[] = [
  makePOI({ id: "h1", name: "西湖", city: "杭州", category: "景点", lat: 30.243, lng: 120.149, visit_minutes: 150, walking_minutes: 40, stairs: 0, indoor: "outdoor", price_per_person: 0, mobility_note: "环湖步道长，老人量力而行" }),
  makePOI({ id: "h2", name: "浙江省博物馆", city: "杭州", category: "景点", lat: 30.254, lng: 120.141, visit_minutes: 90, walking_minutes: 15, stairs: 0, indoor: "indoor", price_per_person: 0, needs_reservation: true, mobility_note: "无障碍" }),
  makePOI({ id: "h3", name: "灵隐寺", city: "杭州", category: "景点", lat: 30.241, lng: 120.098, visit_minutes: 120, walking_minutes: 30, stairs: 35, indoor: "outdoor", price_per_person: 45, mobility_note: "台阶多" }),
  makePOI({ id: "h4", name: "中国茶叶博物馆", city: "杭州", category: "景点", lat: 30.221, lng: 120.118, visit_minutes: 75, walking_minutes: 15, stairs: 0, indoor: "indoor", price_per_person: 0, mobility_note: "无障碍，雨天优选" }),
  makePOI({ id: "h5", name: "雷峰塔", city: "杭州", category: "景点", lat: 30.232, lng: 120.148, visit_minutes: 60, walking_minutes: 18, stairs: 0, indoor: "mixed", price_per_person: 40, mobility_note: "有电梯" }),
  makePOI({ id: "h6", name: "太子湾公园", city: "杭州", category: "景点", lat: 30.231, lng: 120.145, visit_minutes: 90, walking_minutes: 25, stairs: 0, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "h7", name: "宋城", city: "杭州", category: "景点", lat: 30.198, lng: 120.102, visit_minutes: 180, walking_minutes: 35, stairs: 5, indoor: "mixed", price_per_person: 310 }),
  makePOI({ id: "h8", name: "浙江大学", city: "杭州", category: "景点", lat: 30.274, lng: 120.157, visit_minutes: 75, walking_minutes: 20, stairs: 0, indoor: "outdoor", price_per_person: 0, mobility_note: "校园平坦" }),
  makePOI({ id: "h9", name: "西溪湿地", city: "杭州", category: "景点", lat: 30.271, lng: 120.072, visit_minutes: 150, walking_minutes: 30, stairs: 0, indoor: "outdoor", price_per_person: 80 }),
  makePOI({ id: "h10", name: "飞来峰", city: "杭州", category: "景点", lat: 30.242, lng: 120.096, visit_minutes: 90, walking_minutes: 25, stairs: 18, indoor: "outdoor", price_per_person: 45 }),
  makePOI({ id: "hr1", name: "外婆家", city: "杭州", category: "餐厅", lat: 30.246, lng: 120.152, visit_minutes: 60, walking_minutes: 10, stairs: 0, indoor: "indoor", price_per_person: 90 }),
  makePOI({ id: "hr2", name: "楼外楼", city: "杭州", category: "餐厅", lat: 30.236, lng: 120.148, visit_minutes: 60, walking_minutes: 12, stairs: 3, indoor: "indoor", price_per_person: 180 }),
  makePOI({ id: "hh1", name: "杭州西湖大酒店", city: "杭州", category: "酒店", lat: 30.236, lng: 120.152, visit_minutes: 1440, walking_minutes: 0, stairs: 0, indoor: "indoor", price_per_person: 380, mobility_note: "无障碍" }),
];

// 南京
const _NANJING: POI[] = [
  makePOI({ id: "n1", name: "中山陵", city: "南京", category: "景点", lat: 32.058, lng: 118.874, visit_minutes: 120, walking_minutes: 30, stairs: 392, indoor: "outdoor", price_per_person: 0, mobility_note: "台阶极多，建议坐电梯到顶" }),
  makePOI({ id: "n2", name: "夫子庙", city: "南京", category: "景点", lat: 32.027, lng: 118.798, visit_minutes: 90, walking_minutes: 25, stairs: 2, indoor: "mixed", price_per_person: 0, mobility_note: "步行街" }),
  makePOI({ id: "n3", name: "总统府", city: "南京", category: "景点", lat: 32.046, lng: 118.796, visit_minutes: 90, walking_minutes: 15, stairs: 5, indoor: "indoor", price_per_person: 35, needs_reservation: true }),
  makePOI({ id: "n4", name: "南京博物院", city: "南京", category: "景点", lat: 32.041, lng: 118.825, visit_minutes: 120, walking_minutes: 20, stairs: 0, indoor: "indoor", price_per_person: 0, needs_reservation: true, mobility_note: "全馆无障碍，雨天优选" }),
  makePOI({ id: "n5", name: "明孝陵", city: "南京", category: "景点", lat: 32.065, lng: 118.881, visit_minutes: 120, walking_minutes: 35, stairs: 12, indoor: "outdoor", price_per_person: 70 }),
  makePOI({ id: "n6", name: "老门东", city: "南京", category: "景点", lat: 32.019, lng: 118.799, visit_minutes: 90, walking_minutes: 18, stairs: 0, indoor: "mixed", price_per_person: 0, mobility_note: "平坦石板路" }),
  makePOI({ id: "n7", name: "玄武湖", city: "南京", category: "景点", lat: 32.053, lng: 118.796, visit_minutes: 120, walking_minutes: 30, stairs: 0, indoor: "outdoor", price_per_person: 0, mobility_note: "环湖步道平坦" }),
  makePOI({ id: "n8", name: "大屠杀遇难同胞纪念馆", city: "南京", category: "景点", lat: 32.041, lng: 118.769, visit_minutes: 90, walking_minutes: 15, stairs: 0, indoor: "indoor", price_per_person: 0, mobility_note: "全馆无障碍" }),
  makePOI({ id: "n9", name: "牛首山", city: "南京", category: "景点", lat: 31.989, lng: 118.772, visit_minutes: 180, walking_minutes: 45, stairs: 30, indoor: "mixed", price_per_person: 98, mobility_note: "景区内有接驳车" }),
  makePOI({ id: "n10", name: "鸡鸣寺", city: "南京", category: "景点", lat: 32.054, lng: 118.796, visit_minutes: 60, walking_minutes: 12, stairs: 18, indoor: "outdoor", price_per_person: 10 }),
  makePOI({ id: "nr1", name: "南京大牌档", city: "南京", category: "餐厅", lat: 32.026, lng: 118.801, visit_minutes: 60, walking_minutes: 8, stairs: 0, indoor: "indoor", price_per_person: 85 }),
  makePOI({ id: "nr2", name: "狮子头餐厅", city: "南京", category: "餐厅", lat: 32.045, lng: 118.797, visit_minutes: 60, walking_minutes: 10, stairs: 2, indoor: "indoor", price_per_person: 100 }),
  makePOI({ id: "nh1", name: "南京金陵饭店", city: "南京", category: "酒店", lat: 32.046, lng: 118.793, visit_minutes: 1440, walking_minutes: 0, stairs: 0, indoor: "indoor", price_per_person: 420, mobility_note: "全馆无障碍" }),
];

/**
 * 离线模式扩充景点池：每城再补 20 个真实景点 / 场馆，避免离线只有 10 个候选。
 * 坐标为 approximations（用于前端示意地图与距离估算），仅需城市内相对位置正确。
 */
const _SUZHOU_EXTRA: POI[] = [
  makePOI({ id: "s11", name: "留园", city: "苏州", category: "景点", lat: 31.317, lng: 120.593, visit_minutes: 120, walking_minutes: 25, stairs: 8, indoor: "outdoor", price_per_person: 55, open_hours: "07:30-17:00" }),
  makePOI({ id: "s12", name: "寒山寺", city: "苏州", category: "景点", lat: 31.310, lng: 120.585, visit_minutes: 75, walking_minutes: 20, stairs: 12, indoor: "mixed", price_per_person: 20 }),
  makePOI({ id: "s13", name: "西园寺", city: "苏州", category: "景点", lat: 31.314, lng: 120.594, visit_minutes: 75, walking_minutes: 18, stairs: 6, indoor: "mixed", price_per_person: 5 }),
  makePOI({ id: "s14", name: "北寺塔", city: "苏州", category: "景点", lat: 31.325, lng: 120.620, visit_minutes: 60, walking_minutes: 12, stairs: 20, indoor: "outdoor", price_per_person: 0, mobility_note: "塔内台阶较多，可只在庭院游览" }),
  makePOI({ id: "s15", name: "耦园", city: "苏州", category: "景点", lat: 31.322, lng: 120.641, visit_minutes: 75, walking_minutes: 15, stairs: 5, indoor: "outdoor", price_per_person: 25 }),
  makePOI({ id: "s16", name: "艺圃", city: "苏州", category: "景点", lat: 31.314, lng: 120.617, visit_minutes: 60, walking_minutes: 12, stairs: 4, indoor: "outdoor", price_per_person: 10 }),
  makePOI({ id: "s17", name: "网师园夜游", city: "苏州", category: "景点", lat: 31.320, lng: 120.632, visit_minutes: 90, walking_minutes: 12, stairs: 5, indoor: "mixed", price_per_person: 120 }),
  makePOI({ id: "s18", name: "盘门景区", city: "苏州", category: "景点", lat: 31.298, lng: 120.617, visit_minutes: 90, walking_minutes: 22, stairs: 15, indoor: "outdoor", price_per_person: 40 }),
  makePOI({ id: "s19", name: "金鸡湖", city: "苏州", category: "景点", lat: 31.318, lng: 120.681, visit_minutes: 120, walking_minutes: 30, indoor: "outdoor", price_per_person: 0, mobility_note: "湖滨步道平坦" }),
  makePOI({ id: "s20", name: "东方之门", city: "苏州", category: "景点", lat: 31.318, lng: 120.674, visit_minutes: 60, walking_minutes: 15, indoor: "indoor", price_per_person: 0 }),
  makePOI({ id: "s21", name: "苏州中心商场", city: "苏州", category: "购物", lat: 31.317, lng: 120.674, visit_minutes: 90, walking_minutes: 15, indoor: "indoor", price_per_person: 0, mobility_note: "全馆无障碍，雨天优选" }),
  makePOI({ id: "s22", name: "同里古镇", city: "苏州", category: "景点", lat: 31.156, lng: 120.839, visit_minutes: 180, walking_minutes: 35, stairs: 10, indoor: "outdoor", price_per_person: 100 }),
  makePOI({ id: "s23", name: "甪直古镇", city: "苏州", category: "景点", lat: 31.270, lng: 120.889, visit_minutes: 150, walking_minutes: 30, stairs: 5, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "s24", name: "锦溪古镇", city: "苏州", category: "景点", lat: 31.147, lng: 120.889, visit_minutes: 150, walking_minutes: 30, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "s25", name: "千灯古镇", city: "苏州", category: "景点", lat: 31.220, lng: 120.990, visit_minutes: 150, walking_minutes: 30, indoor: "outdoor", price_per_person: 60 }),
  makePOI({ id: "s26", name: "天平山", city: "苏州", category: "景点", lat: 31.315, lng: 120.545, visit_minutes: 180, walking_minutes: 40, stairs: 60, indoor: "outdoor", price_per_person: 30, mobility_note: "山路陡峭，老人慎行" }),
  makePOI({ id: "s27", name: "穹窿山", city: "苏州", category: "景点", lat: 31.254, lng: 120.434, visit_minutes: 180, walking_minutes: 45, stairs: 50, indoor: "outdoor", price_per_person: 80 }),
  makePOI({ id: "s28", name: "沙家浜", city: "苏州", category: "景点", lat: 31.573, lng: 120.799, visit_minutes: 150, walking_minutes: 30, indoor: "outdoor", price_per_person: 100 }),
  makePOI({ id: "s29", name: "阳澄湖莲花岛", city: "苏州", category: "景点", lat: 31.383, lng: 120.750, visit_minutes: 150, walking_minutes: 25, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "s30", name: "苏州乐园森林世界", city: "苏州", category: "景点", lat: 31.322, lng: 120.590, visit_minutes: 240, walking_minutes: 40, stairs: 20, indoor: "mixed", price_per_person: 230 }),
];

const _HANGZHOU_EXTRA: POI[] = [
  makePOI({ id: "h11", name: "断桥残雪", city: "杭州", category: "景点", lat: 30.258, lng: 120.150, visit_minutes: 60, walking_minutes: 15, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "h12", name: "苏堤春晓", city: "杭州", category: "景点", lat: 30.240, lng: 120.140, visit_minutes: 120, walking_minutes: 30, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "h13", name: "三潭印月", city: "杭州", category: "景点", lat: 30.240, lng: 120.144, visit_minutes: 90, walking_minutes: 20, indoor: "outdoor", price_per_person: 55 }),
  makePOI({ id: "h14", name: "花港观鱼", city: "杭州", category: "景点", lat: 30.232, lng: 120.137, visit_minutes: 75, walking_minutes: 20, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "h15", name: "曲院风荷", city: "杭州", category: "景点", lat: 30.253, lng: 120.130, visit_minutes: 75, walking_minutes: 20, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "h16", name: "柳浪闻莺", city: "杭州", category: "景点", lat: 30.240, lng: 120.153, visit_minutes: 60, walking_minutes: 15, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "h17", name: "六和塔", city: "杭州", category: "景点", lat: 30.197, lng: 120.128, visit_minutes: 90, walking_minutes: 25, stairs: 40, indoor: "outdoor", price_per_person: 20 }),
  makePOI({ id: "h18", name: "九溪烟树", city: "杭州", category: "景点", lat: 30.207, lng: 120.112, visit_minutes: 120, walking_minutes: 30, stairs: 15, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "h19", name: "龙井村", city: "杭州", category: "景点", lat: 30.222, lng: 120.101, visit_minutes: 120, walking_minutes: 25, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "h20", name: "满觉陇", city: "杭州", category: "景点", lat: 30.216, lng: 120.124, visit_minutes: 90, walking_minutes: 25, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "h21", name: "杭州植物园", city: "杭州", category: "景点", lat: 30.260, lng: 120.120, visit_minutes: 120, walking_minutes: 25, indoor: "outdoor", price_per_person: 10 }),
  makePOI({ id: "h22", name: "杭州动物园", city: "杭州", category: "景点", lat: 30.230, lng: 120.129, visit_minutes: 150, walking_minutes: 30, stairs: 20, indoor: "mixed", price_per_person: 20 }),
  makePOI({ id: "h23", name: "拱宸桥", city: "杭州", category: "景点", lat: 30.310, lng: 120.140, visit_minutes: 60, walking_minutes: 15, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "h24", name: "小河直街", city: "杭州", category: "景点", lat: 30.310, lng: 120.130, visit_minutes: 90, walking_minutes: 20, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "h25", name: "河坊街", city: "杭州", category: "景点", lat: 30.240, lng: 120.167, visit_minutes: 90, walking_minutes: 20, indoor: "mixed", price_per_person: 0 }),
  makePOI({ id: "h26", name: "南宋御街", city: "杭州", category: "景点", lat: 30.240, lng: 120.168, visit_minutes: 75, walking_minutes: 18, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "h27", name: "吴山广场", city: "杭州", category: "景点", lat: 30.238, lng: 120.168, visit_minutes: 60, walking_minutes: 15, stairs: 10, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "h28", name: "湘湖", city: "杭州", category: "景点", lat: 30.190, lng: 120.210, visit_minutes: 150, walking_minutes: 30, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "h29", name: "良渚古城遗址公园", city: "杭州", category: "景点", lat: 30.393, lng: 120.000, visit_minutes: 180, walking_minutes: 35, indoor: "outdoor", price_per_person: 80, needs_reservation: true }),
  makePOI({ id: "h30", name: "杭州钱江新城", city: "杭州", category: "景点", lat: 30.250, lng: 120.210, visit_minutes: 90, walking_minutes: 20, indoor: "outdoor", price_per_person: 0 }),
  // 购物：保证离线模式六个分类都能高亮
  makePOI({ id: "hs1", name: "湖滨银泰 in77", city: "杭州", category: "购物", lat: 30.249, lng: 120.165, visit_minutes: 90, walking_minutes: 15, indoor: "indoor", price_per_person: 0, open_hours: "10:00-22:00" }),
  makePOI({ id: "hs2", name: "杭州大厦", city: "杭州", category: "购物", lat: 30.268, lng: 120.169, visit_minutes: 90, walking_minutes: 15, indoor: "indoor", price_per_person: 0, open_hours: "10:00-22:00" }),
  makePOI({ id: "hs3", name: "杭州万象城", city: "杭州", category: "购物", lat: 30.251, lng: 120.212, visit_minutes: 90, walking_minutes: 15, indoor: "indoor", price_per_person: 0, open_hours: "10:00-22:00" }),
];

const _NANJING_EXTRA: POI[] = [
  makePOI({ id: "n11", name: "明城墙台城段", city: "南京", category: "景点", lat: 32.060, lng: 118.810, visit_minutes: 90, walking_minutes: 25, stairs: 45, indoor: "outdoor", price_per_person: 30, mobility_note: "城墙台阶多，可在玄武湖侧远眺" }),
  makePOI({ id: "n12", name: "中华门城堡", city: "南京", category: "景点", lat: 32.010, lng: 118.790, visit_minutes: 75, walking_minutes: 20, stairs: 30, indoor: "outdoor", price_per_person: 50 }),
  makePOI({ id: "n13", name: "雨花台风景区", city: "南京", category: "景点", lat: 32.000, lng: 118.780, visit_minutes: 120, walking_minutes: 30, stairs: 15, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "n14", name: "栖霞山", city: "南京", category: "景点", lat: 32.160, lng: 118.950, visit_minutes: 180, walking_minutes: 40, stairs: 55, indoor: "outdoor", price_per_person: 40 }),
  makePOI({ id: "n15", name: "燕子矶", city: "南京", category: "景点", lat: 32.140, lng: 118.810, visit_minutes: 90, walking_minutes: 25, stairs: 20, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "n16", name: "红山森林动物园", city: "南京", category: "景点", lat: 32.090, lng: 118.800, visit_minutes: 180, walking_minutes: 35, stairs: 30, indoor: "mixed", price_per_person: 40 }),
  makePOI({ id: "n17", name: "南京海底世界", city: "南京", category: "景点", lat: 32.055, lng: 118.840, visit_minutes: 120, walking_minutes: 20, stairs: 0, indoor: "indoor", price_per_person: 150, mobility_note: "全馆无障碍，雨天优选" }),
  makePOI({ id: "n18", name: "瞻园", city: "南京", category: "景点", lat: 32.025, lng: 118.795, visit_minutes: 75, walking_minutes: 15, stairs: 8, indoor: "outdoor", price_per_person: 30 }),
  makePOI({ id: "n19", name: "甘熙故居", city: "南京", category: "景点", lat: 32.028, lng: 118.798, visit_minutes: 75, walking_minutes: 15, stairs: 5, indoor: "mixed", price_per_person: 20 }),
  makePOI({ id: "n20", name: "朝天宫", city: "南京", category: "景点", lat: 32.037, lng: 118.785, visit_minutes: 90, walking_minutes: 20, stairs: 25, indoor: "mixed", price_per_person: 25 }),
  makePOI({ id: "n21", name: "六朝博物馆", city: "南京", category: "景点", lat: 32.045, lng: 118.796, visit_minutes: 90, walking_minutes: 15, stairs: 0, indoor: "indoor", price_per_person: 30, mobility_note: "全馆无障碍" }),
  makePOI({ id: "n22", name: "南京云锦博物馆", city: "南京", category: "景点", lat: 32.040, lng: 118.790, visit_minutes: 75, walking_minutes: 15, stairs: 0, indoor: "indoor", price_per_person: 0 }),
  makePOI({ id: "n23", name: "毗卢寺", city: "南京", category: "景点", lat: 32.047, lng: 118.800, visit_minutes: 60, walking_minutes: 12, indoor: "mixed", price_per_person: 0 }),
  makePOI({ id: "n24", name: "秦淮河游船", city: "南京", category: "景点", lat: 32.027, lng: 118.798, visit_minutes: 60, walking_minutes: 10, stairs: 5, indoor: "outdoor", price_per_person: 80 }),
  makePOI({ id: "n25", name: "珍珠泉风景区", city: "南京", category: "景点", lat: 32.120, lng: 118.760, visit_minutes: 150, walking_minutes: 30, indoor: "outdoor", price_per_person: 40 }),
  makePOI({ id: "n26", name: "浦口火车站旧址", city: "南京", category: "景点", lat: 32.090, lng: 118.720, visit_minutes: 75, walking_minutes: 20, indoor: "mixed", price_per_person: 0 }),
  makePOI({ id: "n27", name: "汤山温泉", city: "南京", category: "景点", lat: 32.030, lng: 118.990, visit_minutes: 180, walking_minutes: 20, stairs: 0, indoor: "indoor", price_per_person: 200, mobility_note: "室内泡池，雨天优选" }),
  makePOI({ id: "n28", name: "方山风景区", city: "南京", category: "景点", lat: 31.930, lng: 118.840, visit_minutes: 150, walking_minutes: 35, stairs: 40, indoor: "outdoor", price_per_person: 0 }),
  makePOI({ id: "n29", name: "南京城墙博物馆", city: "南京", category: "景点", lat: 32.010, lng: 118.790, visit_minutes: 75, walking_minutes: 15, stairs: 0, indoor: "indoor", price_per_person: 0, mobility_note: "全馆无障碍" }),
  makePOI({ id: "n30", name: "老山国家森林公园", city: "南京", category: "景点", lat: 32.080, lng: 118.600, visit_minutes: 180, walking_minutes: 40, stairs: 35, indoor: "outdoor", price_per_person: 0 }),
  // 购物：保证离线模式六个分类都能高亮
  makePOI({ id: "ns1", name: "德基广场", city: "南京", category: "购物", lat: 32.043, lng: 118.788, visit_minutes: 90, walking_minutes: 15, indoor: "indoor", price_per_person: 0, open_hours: "10:00-22:00" }),
  makePOI({ id: "ns2", name: "金鹰国际购物中心", city: "南京", category: "购物", lat: 32.042, lng: 118.790, visit_minutes: 90, walking_minutes: 15, indoor: "indoor", price_per_person: 0, open_hours: "10:00-22:00" }),
  makePOI({ id: "ns3", name: "南京新百", city: "南京", category: "购物", lat: 32.042, lng: 118.789, visit_minutes: 90, walking_minutes: 15, indoor: "indoor", price_per_person: 0, open_hours: "09:30-21:30" }),
];

/**
 * 交通枢纽点：让离线模式点「机场 / 火车站」分类也能在地图上高亮。
 * 不与景点池混排推荐（AI 只取 category=景点）。
 */
const _TRANSPORT_EXTRA: POI[] = [
  // 苏州（本地无民航机场，收录常用苏南硕放国际机场）
  makePOI({ id: "st1", name: "苏州站", city: "苏州", category: "火车站", lat: 31.330, lng: 120.612, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", price_per_person: 0, open_hours: "全天", mobility_note: "站内无障碍通道" }),
  makePOI({ id: "st2", name: "苏州北站", city: "苏州", category: "火车站", lat: 31.432, lng: 120.628, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", price_per_person: 0, open_hours: "全天", mobility_note: "高铁站，站内无障碍通道" }),
  makePOI({ id: "sa1", name: "苏南硕放国际机场", city: "苏州", category: "机场", lat: 31.488, lng: 120.429, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", price_per_person: 0, open_hours: "全天", mobility_note: "位于无锡，为苏州常用机场" }),
  // 杭州
  makePOI({ id: "ht1", name: "杭州东站", city: "杭州", category: "火车站", lat: 30.290, lng: 120.213, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", price_per_person: 0, open_hours: "全天", mobility_note: "站内无障碍通道" }),
  makePOI({ id: "ht2", name: "杭州站", city: "杭州", category: "火车站", lat: 30.248, lng: 120.169, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", price_per_person: 0, open_hours: "全天" }),
  makePOI({ id: "ha1", name: "杭州萧山国际机场", city: "杭州", category: "机场", lat: 30.229, lng: 120.434, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", price_per_person: 0, open_hours: "全天", mobility_note: "航站楼无障碍" }),
  // 南京
  makePOI({ id: "nt1", name: "南京站", city: "南京", category: "火车站", lat: 32.084, lng: 118.786, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", price_per_person: 0, open_hours: "全天", mobility_note: "站内无障碍通道" }),
  makePOI({ id: "nt2", name: "南京南站", city: "南京", category: "火车站", lat: 31.969, lng: 118.797, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", price_per_person: 0, open_hours: "全天" }),
  makePOI({ id: "na1", name: "南京禄口国际机场", city: "南京", category: "机场", lat: 31.742, lng: 118.862, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", price_per_person: 0, open_hours: "全天", mobility_note: "航站楼无障碍" }),
  // ── 全国主要城市交通枢纽：离线模式下点机场 / 火车站也能高亮 ──
  // 北京
  makePOI({ id: "bj-air1", name: "北京首都国际机场", city: "北京", category: "机场", lat: 40.080, lng: 116.585, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "bj-air2", name: "北京大兴国际机场", city: "北京", category: "机场", lat: 39.510, lng: 116.411, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "bj-tr1", name: "北京南站", city: "北京", category: "火车站", lat: 39.865, lng: 116.379, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "bj-tr2", name: "北京站", city: "北京", category: "火车站", lat: 39.905, lng: 116.427, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "bj-tr3", name: "北京西站", city: "北京", category: "火车站", lat: 39.895, lng: 116.322, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
  // 上海
  makePOI({ id: "sh-air1", name: "上海浦东国际机场", city: "上海", category: "机场", lat: 31.144, lng: 121.808, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "sh-air2", name: "上海虹桥国际机场", city: "上海", category: "机场", lat: 31.198, lng: 121.336, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "sh-tr1", name: "上海虹桥站", city: "上海", category: "火车站", lat: 31.194, lng: 121.320, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "sh-tr2", name: "上海站", city: "上海", category: "火车站", lat: 31.250, lng: 121.458, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
  // 广州
  makePOI({ id: "gz-air1", name: "广州白云国际机场", city: "广州", category: "机场", lat: 23.392, lng: 113.299, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "gz-tr1", name: "广州南站", city: "广州", category: "火车站", lat: 22.989, lng: 113.269, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "gz-tr2", name: "广州东站", city: "广州", category: "火车站", lat: 23.152, lng: 113.333, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
  // 深圳
  makePOI({ id: "sz-air1", name: "深圳宝安国际机场", city: "深圳", category: "机场", lat: 22.639, lng: 113.811, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "sz-tr1", name: "深圳北站", city: "深圳", category: "火车站", lat: 22.610, lng: 114.029, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
  // 成都
  makePOI({ id: "cd-air1", name: "成都双流国际机场", city: "成都", category: "机场", lat: 30.579, lng: 103.947, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "cd-air2", name: "成都天府国际机场", city: "成都", category: "机场", lat: 30.312, lng: 104.442, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "cd-tr1", name: "成都东站", city: "成都", category: "火车站", lat: 30.608, lng: 104.141, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
  // 西安
  makePOI({ id: "xa-air1", name: "西安咸阳国际机场", city: "西安", category: "机场", lat: 34.447, lng: 108.751, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "xa-tr1", name: "西安北站", city: "西安", category: "火车站", lat: 34.380, lng: 108.933, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
  // 重庆
  makePOI({ id: "cq-air1", name: "重庆江北国际机场", city: "重庆", category: "机场", lat: 29.719, lng: 106.641, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "cq-tr1", name: "重庆北站", city: "重庆", category: "火车站", lat: 29.615, lng: 106.554, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
  // 武汉
  makePOI({ id: "wh-air1", name: "武汉天河国际机场", city: "武汉", category: "机场", lat: 30.784, lng: 114.208, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "wh-tr1", name: "武汉站", city: "武汉", category: "火车站", lat: 30.612, lng: 114.436, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
  // 青岛
  makePOI({ id: "qd-air1", name: "青岛胶东国际机场", city: "青岛", category: "机场", lat: 36.359, lng: 120.094, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "qd-tr1", name: "青岛北站", city: "青岛", category: "火车站", lat: 36.158, lng: 120.406, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
  // 天津
  makePOI({ id: "tj-air1", name: "天津滨海国际机场", city: "天津", category: "机场", lat: 39.123, lng: 117.346, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "tj-tr1", name: "天津站", city: "天津", category: "火车站", lat: 39.162, lng: 117.208, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
  // 长沙
  makePOI({ id: "cs-air1", name: "长沙黄花国际机场", city: "长沙", category: "机场", lat: 28.190, lng: 113.220, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "cs-tr1", name: "长沙南站", city: "长沙", category: "火车站", lat: 28.138, lng: 113.062, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
  // 厦门
  makePOI({ id: "xm-air1", name: "厦门高崎国际机场", city: "厦门", category: "机场", lat: 24.545, lng: 118.128, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "xm-tr1", name: "厦门北站", city: "厦门", category: "火车站", lat: 24.638, lng: 118.019, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
  // 昆明
  makePOI({ id: "km-air1", name: "昆明长水国际机场", city: "昆明", category: "机场", lat: 25.102, lng: 102.929, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "km-tr1", name: "昆明南站", city: "昆明", category: "火车站", lat: 24.957, lng: 102.873, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
  // 三亚
  makePOI({ id: "sy-air1", name: "三亚凤凰国际机场", city: "三亚", category: "机场", lat: 18.302, lng: 109.412, visit_minutes: 90, walking_minutes: 30, indoor: "indoor", open_hours: "全天" }),
  makePOI({ id: "sy-tr1", name: "三亚站", city: "三亚", category: "火车站", lat: 18.320, lng: 109.490, visit_minutes: 60, walking_minutes: 20, indoor: "indoor", open_hours: "全天" }),
];

/** 全国交通枢纽查询：离线模式下机场 / 火车站分类用，按城市返回 */
export function load_transport_pois(city: string, category?: "机场" | "火车站"): POI[] {
  const k = _CITY_ALIAS[city] ?? city;
  return _TRANSPORT_EXTRA.filter(
    (p) => p.city === k && (!category || p.category === category),
  );
}

const _CITY_DATA: Record<string, POI[]> = {
  "苏州": [..._SUZHOU, ..._SUZHOU_EXTRA, ..._TRANSPORT_EXTRA.filter((p) => p.city === "苏州")],
  "杭州": [..._HANGZHOU, ..._HANGZHOU_EXTRA, ..._TRANSPORT_EXTRA.filter((p) => p.city === "杭州")],
  "南京": [..._NANJING, ..._NANJING_EXTRA, ..._TRANSPORT_EXTRA.filter((p) => p.city === "南京")],
};

const _CITY_ALIAS: Record<string, string> = {
  "suzhou": "苏州", "苏州": "苏州",
  "hangzhou": "杭州", "杭州": "杭州",
  "nanjing": "南京", "南京": "南京",
};

/** 运行时在线 POI 缓存：无内置快照的城市，由后端调用高德后写入 */
const _RUNTIME_CACHE = new Map<string, POI[]>();

/** 该城市是否有可用 POI 数据（内置快照或运行时在线缓存） */
export function has_city_snapshot(city: string): boolean {
  const k = _CITY_ALIAS[city] ?? city;
  return !!_CITY_DATA[k] || _RUNTIME_CACHE.has(k);
}

/** 是否只有内置快照（本地数据模式用，不含在线缓存） */
export function has_builtin_snapshot(city: string): boolean {
  const k = _CITY_ALIAS[city] ?? city;
  return !!_CITY_DATA[k];
}

/** 注册在线拉取的城市 POI（跨城/任意城市支持） */
export function register_city_pois(city: string, pois: POI[]): void {
  if (pois.length) _RUNTIME_CACHE.set(_CITY_ALIAS[city] ?? city, pois);
}

/** 返回某城市的 POI 快照；支持中文名/英文别名/"全部"，以及逗号分隔的多城市（跨城行程）。 */
export function load_pois(city = "苏州"): POI[] {
  const raw = (city || "").trim();
  if (["全部", "all", "all_cities", ""].includes(raw.toLowerCase())) {
    return Object.values(_CITY_DATA).flat();
  }
  // 跨城市：逗号 / 顿号 / 空格分隔，按顺序合并去重
  const parts = raw.split(/[,，、\s]+/).filter(Boolean);
  if (parts.length > 1) {
    const merged: POI[] = [];
    const seen = new Set<string>();
    for (const p of parts) {
      const k = _CITY_ALIAS[p] ?? p;
      for (const po of _CITY_DATA[k] ?? _RUNTIME_CACHE.get(k) ?? []) {
        if (!seen.has(po.id)) {
          seen.add(po.id);
          merged.push(po);
        }
      }
    }
    if (merged.length) return merged;
  }
  const key = _CITY_ALIAS[raw] ?? raw;
  if (_CITY_DATA[key]) return [..._CITY_DATA[key]];
  if (_RUNTIME_CACHE.has(key)) return [..._RUNTIME_CACHE.get(key)!];
  return [..._SUZHOU];
}

/** 仅返回内置快照数据（本地演示模式），不含在线缓存；支持逗号分隔的多城市 */
export function load_builtin_pois(city = "苏州"): POI[] {
  const parts = (city || "").trim().split(/[,，、\s]+/).filter(Boolean);
  const out: POI[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const k = _CITY_ALIAS[p] ?? p;
    for (const po of _CITY_DATA[k] ?? []) {
      if (!seen.has(po.id)) {
        seen.add(po.id);
        out.push(po);
      }
    }
  }
  return out;
}

export function list_cities(): string[] {
  return Object.keys(_CITY_DATA);
}

/** 备用景点池：扰动发生后用于补位，以室内为主。 */
export function load_backup_pool(city = "苏州"): POI[] {
  const pools: Record<string, POI[]> = {
    "苏州": [
      makePOI({ id: "b1", name: "苏州博物馆西馆", city: "苏州", category: "景点", lat: 31.320, lng: 120.620, visit_minutes: 90, walking_minutes: 10, stairs: 0, indoor: "indoor", price_per_person: 0, mobility_note: "无障碍" }),
      makePOI({ id: "b2", name: "苏州丝绸博物馆", city: "苏州", category: "景点", lat: 31.319, lng: 120.624, visit_minutes: 75, walking_minutes: 12, stairs: 0, indoor: "indoor", price_per_person: 0, mobility_note: "无障碍" }),
      makePOI({ id: "b3", name: "观前街", city: "苏州", category: "景点", lat: 31.313, lng: 120.622, visit_minutes: 90, walking_minutes: 18, stairs: 0, indoor: "mixed", price_per_person: 0 }),
      makePOI({ id: "b4", name: "苏州御窑金砖博物馆", city: "苏州", category: "景点", lat: 31.329, lng: 120.582, visit_minutes: 75, walking_minutes: 20, stairs: 0, indoor: "indoor", price_per_person: 0, mobility_note: "无障碍" }),
    ],
    "杭州": [
      makePOI({ id: "b5", name: "杭州博物馆", city: "杭州", category: "景点", lat: 30.236, lng: 120.146, visit_minutes: 90, walking_minutes: 12, stairs: 0, indoor: "indoor", price_per_person: 0, mobility_note: "无障碍" }),
      makePOI({ id: "b6", name: "中国丝绸博物馆", city: "杭州", category: "景点", lat: 30.217, lng: 120.119, visit_minutes: 75, walking_minutes: 15, stairs: 0, indoor: "indoor", price_per_person: 0 }),
      makePOI({ id: "b7", name: "杭州图书馆", city: "杭州", category: "景点", lat: 30.246, lng: 120.152, visit_minutes: 90, walking_minutes: 18, stairs: 0, indoor: "indoor", price_per_person: 0, mobility_note: "无障碍" }),
    ],
    "南京": [
      makePOI({ id: "b8", name: "南京市民俗博物馆", city: "南京", category: "景点", lat: 32.028, lng: 118.800, visit_minutes: 75, walking_minutes: 12, stairs: 0, indoor: "indoor", price_per_person: 0, mobility_note: "无障碍" }),
      makePOI({ id: "b9", name: "江宁织造博物馆", city: "南京", category: "景点", lat: 32.050, lng: 118.800, visit_minutes: 75, walking_minutes: 15, stairs: 0, indoor: "indoor", price_per_person: 0 }),
    ],
  };
  const key = _CITY_ALIAS[city] ?? city;
  return [...(pools[key] ?? pools["苏州"])];
}

/** 示例：带 60 岁老人 + 8 岁儿童的家庭出行约束。 */
export function sample_constraints(): Constraints {
  return makeConstraints({
    budget_total: 6000,
    max_walking_minutes_per_day: 90,
    max_stairs_per_item: 20,
    max_items_per_day: 4,
    require_afternoon_indoor: true,
    nap_required: true,
    must_visit: ["s2"],
    travelers: [
      makeTraveler({ name: "父亲", age: 60, mobility: "slow" }),
      makeTraveler({ name: "孩子", age: 8, mobility: "child", needs_nap: true }),
      makeTraveler({ name: "我", age: 32, mobility: "normal" }),
    ],
  });
}
