/**
 * 途稳 · 普通用户端（登录后的旅行规划主界面）。
 * 两个视图：
 *   - AI 规划：旅行偏好面板 → 开始规划 → 地图 / 指标 / 行程 / 重规划
 *   - 手动路线：从 POI 选点、拖拽排序、分天 → 地图实时打点 → 应用为本地行程 / 让 AI 优化
 * 地图始终作为英雄区，points 随当前视图切换（数据流闭环：视图 → points → MapView 重绘）。
 *
 * 与管理端 AdminApp 是两套完全独立的组件树 / 信息架构，不是同一 DOM 的隐藏切换。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  fetchModels,
  fetchCities,
  fetchPois,
  fetchWeather,
  fetchAmapCity,
  fetchAmapPoiBriefs,
  fetchAmapConfig,
  fetchTransport,
  fetchProfile,
  runStream,
  defaultPreferences,
  type StreamEvent,
  type ModelOption,
  type ItineraryView,
  type MetricsView,
  type PoiSnapshot,
  type AmapPoiBrief,
  type MapPoint,
  type ManualStop,
  type TravelPreferences,
  type WeatherForecast,
  type TransportPlan,
  type TransportMode,
  type IntercityLegs,
  type DataSource,
  type UserProfile,
} from "./api";
import {
  buildPreferenceRequirement,
  buildManualRouteRequirement,
  buildManualItinerary,
  estimateTravelerCount,
  reorderStopsByItinerary,
  optimizeStopsLocally,
  manualStopsToMapPoints,
  sortItineraryItems,
  summarizeWeather,
} from "./route-utils";
import type { AuthUser } from "./auth";
import { transportModeLabel, HOT_SCENIC_BY_CITY } from "./meta";
import TopBar from "./components/TopBar";
import ControlPanel from "./components/ControlPanel";
import IntercityPanel from "./components/IntercityPanel";
import ProfileModal from "./components/ProfileModal";
import PreferencePanel from "./components/PreferencePanel";
import ManualRoute from "./components/ManualRoute";
import MapView from "./components/MapView";
import WeatherForecastView from "./components/WeatherForecast";
import MetricsStrip from "./components/MetricsStrip";
import ItineraryTimeline from "./components/ItineraryTimeline";
import ExportBar from "./components/ExportBar";
import ProposalCard from "./components/ProposalCard";
import { buildWeatherAdjustment } from "./weather-adjust";
import { newProposalId, type Proposal, type ProposalChange } from "./proposal";
import ReplanPanel from "./components/ReplanPanel";
import BudgetPanel from "./components/BudgetPanel";
import { loadSession, saveSession, clearSession, type SavedSession } from "./storage";

type View = "ai" | "manual";

/** 只保留景点：美食 / 餐厅、酒店、购物等不进入 AI 推荐与必去候选 */
function scenicOnly(pois: PoiSnapshot[]): PoiSnapshot[] {
  return pois.filter((p) => p.category === "景点");
}

/** 热门景点排序：在线按高德评分，离线按城市经典榜单，其次票价，只取前 N 张推荐卡 */
function hotScenic(pois: PoiSnapshot[], cityName: string, n = 9): PoiSnapshot[] {
  const hotList = HOT_SCENIC_BY_CITY[cityName] || [];
  const rank = (po: PoiSnapshot) => {
    const i = hotList.indexOf(po.name);
    return i >= 0 ? i : hotList.length + 100;
  };
  return [...pois]
    .sort((a, b) => {
      const ra = Number(a.rating) || 0;
      const rb = Number(b.rating) || 0;
      // 有评分的在线数据优先；离线快照无评分时按经典榜单顺序
      if (ra || rb) {
        if (rb !== ra) return rb - ra;
      } else {
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
      }
      const pa = Number(a.price_per_person) || 0;
      const pb = Number(b.price_per_person) || 0;
      return pb - pa;
    })
    .slice(0, n);
}

/** 本地时区的今天（YYYY-MM-DD） */
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 日期字符串加 n 天（本地时区） */
function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 两个日期相差的天数（b - a） */
function diffDays(a: string, b: string): number {
  const ta = new Date(`${a}T00:00:00`).getTime();
  const tb = new Date(`${b}T00:00:00`).getTime();
  return Math.round((tb - ta) / 86400000);
}

export default function UserApp({
  user,
  onLogout,
}: {
  user: AuthUser;
  onLogout: () => void;
}) {
  // 恢复上次未完成的输入（只读恢复用户自己的表单，不回放 Agent 运行产物）
  const [restored] = useState(() => loadSession());
  const [view, setView] = useState<View>(restored?.view || "ai");

  const [models, setModels] = useState<ModelOption[]>([]);
  const [hotCities, setHotCities] = useState<string[]>([]);
  const [cityOptions, setCityOptions] = useState<string[]>([]);
  // 数据源：local=内置快照演示，online=高德在线（记住上次选择）
  const [dataSource, setDataSource] = useState<DataSource>(() => {
    try {
      return localStorage.getItem("tw_data_source") === "local" ? "local" : "online";
    } catch {
      return "online";
    }
  });
  // 服务端是否配置了高德 Web 服务 Key（在线模式拉全量 POI 依赖它）
  const [amapEnabled, setAmapEnabled] = useState<boolean | null>(null);

  // 已选城市（1-3 个，支持跨城）
  // 默认全部留空：由用户自行选择城市与出行日期
  const [selectedCities, setSelectedCities] = useState<string[]>(restored?.cities || []);
  const [startDate, setStartDate] = useState<string>(restored?.startDate || "");
  const [endDate, setEndDate] = useState<string>(restored?.endDate || "");
  const [poiOptions, setPoiOptions] = useState<string[]>([]);
  // 必去景点候选详情（缩略图 / 评分 / 营业时间），与 poiOptions 同步更新
  const [poiBriefs, setPoiBriefs] = useState<AmapPoiBrief[]>([]);

  // 个人信息（所属城市 = 出发城市，用于城际交通推荐）
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const fromCity = profile?.city || "";

  const [transport, setTransport] = useState<TransportPlan | null>(null);
  const [transportMode, setTransportMode] = useState<TransportMode | null>(null);
  const [transportLoading, setTransportLoading] = useState(false);
  const [transportError, setTransportError] = useState("");

  // 天数由日期区间动态计算；日期未选全时按 1 天兜底
  const days = startDate && endDate ? Math.max(1, diffDays(startDate, endDate) + 1) : 1;
  const tripReady = selectedCities.length > 0 && !!startDate && !!endDate;
  // 出发日期变化时，若结束日期早于新的出发日期则自动顺延
  const handleStartDate = (v: string) => {
    setStartDate(v);
    if (endDate && endDate < v) setEndDate(v);
  };
  // 出行天气预报（城市/天数变化时拉取；null 则不渲染，不影响主链路）
  const [weather, setWeather] = useState<WeatherForecast[]>([]);
  // 天气请求序号：丢弃过期响应，避免多城市快速切换时数据互相覆盖
  const weatherReqRef = useRef(0);
  const [modelKey] = useState<string | undefined>(undefined);

  // 跨城：传给后端/接口用逗号串（后端 load_pois 支持多城市），展示用顿号
  const city = selectedCities.join(",");
  const cityLabel = selectedCities.length ? selectedCities.join("、") : "未选择城市";
  const primaryCity = selectedCities[0] || "苏州";

  // 旅行偏好 + 补充描述（AI 视图）
  // 刻意不持久化：刷新页面即回到默认值，不保留上一次勾选的选项。
  const [prefs, setPrefs] = useState<TravelPreferences>(() => ({
    ...defaultPreferences,
    group: [...defaultPreferences.group],
    must_visit: [...defaultPreferences.must_visit],
    avoid: [...defaultPreferences.avoid],
  }));
  const [requirementExtra, setRequirementExtra] = useState<string>("");
  const travelerCount = estimateTravelerCount(prefs.group);

  // 手动路线状态
  const [manualStops, setManualStops] = useState<ManualStop[]>(restored?.manualStops || []);
  const [manualItinerary, setManualItinerary] = useState<ItineraryView | null>(null);

  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [itinerary, setItinerary] = useState<ItineraryView | null>(null);
  const [replanItinerary, setReplanItinerary] = useState<ItineraryView | null>(null);
  const [replanDetail, setReplanDetail] = useState<any>(null);
  const [stressDetail, setStressDetail] = useState<any>(null);
  const [metrics, setMetrics] = useState<MetricsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 改动提案（天气调整 / AI 优化）：确认后才写入 itinerary / manualStops
  const [proposal, setProposal] = useState<Proposal | null>(null);
  // 天气调整无法生成方案时的轻提示
  const [adjustNotice, setAdjustNotice] = useState("");

  // 运行类型：普通 AI 规划 / 基于手动路线优化（用 ref 避免闭包旧值）
  const runKindRef = useRef<"plain" | "optimize">("plain");

  // 城市 POI 快照（AI 视图地图补坐标 + 偏好必去 / 手动选点的候选源）
  const [pois, setPois] = useState<PoiSnapshot[]>([]);
  /** POI 请求序号：快速切城市时丢弃过期响应 */
  const poisReqRef = useRef(0);
  useEffect(() => {
    // 未选城市时不加载 POI 候选
    if (!city) {
      setPois([]);
      return;
    }
    let alive = true;
    const reqId = ++poisReqRef.current;
    fetchPois(city, dataSource)
      // 城市快速切换时只接受最后一次请求的结果，避免旧城市 POI 覆盖新城市
      .then((ps) => {
        if (alive && poisReqRef.current === reqId) setPois(ps);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [city, dataSource]);

  // 必去景点候选兜底：城市 POI 到位后立即填充候选卡片（本地快照 / 线上高德都有数据），
  // 不再依赖用户先输入搜索才有内容；城市切换时丢弃旧城市候选，用户搜索结果优先于兜底。
  const briefsCityRef = useRef("");
  useEffect(() => {
    if (!pois.length) return;
    // 城市变了：清掉旧候选，等待新一轮 POI 重建
    if (briefsCityRef.current !== city) {
      briefsCityRef.current = city;
      setPoiOptions([]);
      setPoiBriefs([]);
      return;
    }
    // 当前城市已有候选（搜索结果或上轮兜底）则不覆盖
    if (poiBriefs.length) return;
    const scenic = scenicOnly(pois);
    // 下拉候选保留全部景点，推荐卡片只展示评分最高的 9 个
    setPoiOptions(scenic.map((po) => po.name));
    setPoiBriefs(
      hotScenic(scenic, primaryCity, 9).map((po) => ({
        name: po.name,
        address: String(po.address || ""),
        rating: String(po.rating || ""),
        cost: Number(po.price_per_person) > 0 ? String(po.price_per_person) : "",
        openTime: String(po.open_hours || ""),
        photo: String(po.photo || ""),
      })),
    );
  }, [city, pois, poiBriefs]);

  // 出行天气预报：覆盖「出发前一天 ~ 结束后一天」，且不显示已过日期
  useEffect(() => {
    // 城市或日期未选全时不拉取天气
    if (!selectedCities.length || !startDate || !endDate) {
      setWeather([]);
      return;
    }
    let alive = true;
    const today = todayStr();
    const prev = addDays(startDate, -1);
    const from = prev < today ? today : prev; // 已过日期不展示
    const to = addDays(endDate, 1);
    const n = Math.max(1, diffDays(from, to) + 1);
    // 跨城行程：并行拉取所有已选城市的预报（reqId + abort 双重防抖，快速改日期只保留最后一次）
    const reqId = ++weatherReqRef.current;
    const controller = new AbortController();
    Promise.all(selectedCities.map((c) => fetchWeather(c, n, from, controller.signal)))
      .then((list) => {
        if (alive && weatherReqRef.current === reqId) {
          setWeather(list.filter(Boolean) as WeatherForecast[]);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      controller.abort();
    };
  }, [selectedCities.join(","), startDate, endDate]);

  const coordMap = useMemo(() => {
    const m = new Map<string, { lat: number; lng: number; indoor?: string }>();
    pois.forEach((p) => m.set(p.name, { lat: p.lat, lng: p.lng, indoor: p.indoor }));
    return m;
  }, [pois]);

  // 初始化：模型列表 + 在线数据源可用性
  useEffect(() => {
    fetchModels().then(setModels);
    fetchAmapConfig()
      .then((j) => setAmapEnabled(!!j.enabled))
      .catch(() => setAmapEnabled(false));
  }, []);

  // 数据源变化时刷新城市候选：本地=内置快照城市，线上=热门城市 + 高德联想
  useEffect(() => {
    fetchCities(dataSource).then((cs) => {
      setHotCities(cs);
      setCityOptions(cs);
    });
  }, [dataSource]);

  // 读取个人信息（所属城市作为出发城市）
  useEffect(() => {
    fetchProfile()
      .then(setProfile)
      .catch(() => {});
  }, []);

  // 记住数据源，下次打开保持上次选择
  useEffect(() => {
    try {
      localStorage.setItem("tw_data_source", dataSource);
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }, [dataSource]);

  // 自动保存用户输入：只保城市 / 日期 / 手动选点 / 当前视图。
  // 旅行偏好与补充描述不进草稿——刷新后必须回到默认（清空上次选择）。
  // ref 始终持有一份最新草稿，供刷新 / 切后台时同步补写。
  const sessionRef = useRef<SavedSession>({
    view,
    cities: selectedCities,
    startDate,
    endDate,
    manualStops,
  });
  sessionRef.current = {
    view,
    cities: selectedCities,
    startDate,
    endDate,
    manualStops,
  };

  // 首次挂载不写回：此时 state 正是 loadSession 的恢复值，写入没有收益。
  // 之后每次交互都在 paint 前落盘。
  const hydratedRef = useRef(false);
  useLayoutEffect(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return;
    }
    saveSession(sessionRef.current);
  }, [view, selectedCities, startDate, endDate, manualStops]);

  // 刷新 / 关闭标签 / 切后台时同步补写，杜绝「刚选完就刷新」丢草稿
  useEffect(() => {
    const flush = () => saveSession(sessionRef.current);
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []);

  /** 切换数据源：中止规划并清空与之相关的选择与结果，避免本地/线上数据混用 */
  const handleDataSourceChange = (next: DataSource) => {
    if (next === dataSource) return;
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setDataSource(next);
    setSelectedCities([]);
    setPois([]);
    setPoiOptions([]);
    setPoiBriefs([]);
    setEvents([]);
    setItinerary(null);
    setReplanItinerary(null);
    setReplanDetail(null);
    setStressDetail(null);
    setMetrics(null);
    setManualStops([]);
    setManualItinerary(null);
    setError(null);
    setProposal(null);
    setAdjustNotice("");
    setTransport(null);
    setTransportMode(null);
    setTransportError("");
  };

  // 手动路线：按 day + order 排序后的路线，首站 / 末站决定城际交通的起讫
  const orderedManualStops = useMemo(
    () => [...manualStops].sort((a, b) => a.day - b.day || a.order - b.order),
    [manualStops],
  );
  const manualFirstCity = (orderedManualStops[0]?.city || "").trim() || selectedCities[0] || "";
  const manualLastCity =
    ([...orderedManualStops].reverse().find((s) => s.city)?.city || "").trim() ||
    manualFirstCity;

  // 城际交通方案：
  //  - AI 规划：归属地 → 第一个目的地城市
  //  - 手动路线：归属地 → 用户选完路线后的第一站（不是单纯第一个城市）
  const transportTo = view === "manual" ? manualFirstCity : selectedCities[0] || "";
  const transportReqRef = useRef(0);
  useEffect(() => {
    const from = fromCity.trim();
    if (dataSource !== "online" || !from || !transportTo || from === transportTo) {
      setTransport(null);
      setTransportMode(null);
      setTransportError("");
      setTransportLoading(false);
      return;
    }
    const reqId = ++transportReqRef.current;
    let alive = true;
    setTransportLoading(true);
    setTransportError("");
    fetchTransport(from, transportTo, startDate || undefined)
      .then((p) => {
        if (!alive || transportReqRef.current !== reqId) return;
        setTransport(p);
        // 保留用户已选方式；不可用时回落到推荐项
        setTransportMode((m) =>
          m && p.options.some((o) => o.mode === m) ? m : p.recommended,
        );
      })
      .catch((e) => {
        if (!alive || transportReqRef.current !== reqId) return;
        setTransport(null);
        setTransportError(String(e?.message || e));
      })
      .finally(() => {
        if (alive && transportReqRef.current === reqId) setTransportLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [fromCity, transportTo, dataSource, startDate]);

  // AI 视图里偏好面板与城际交通卡片双向同步；手动视图独立选择，不写回 AI 偏好
  useEffect(() => {
    if (view !== "ai" || !prefs.transport_mode || !transport) return;
    if (transport.options.some((o) => o.mode === prefs.transport_mode)) {
      setTransportMode(prefs.transport_mode);
    }
  }, [view, prefs.transport_mode, transport]);

  const handleTransportModeChange = (m: TransportMode) => {
    setTransportMode(m);
    if (view === "ai") setPrefs((prev) => ({ ...prev, transport_mode: m }));
  };

  // 当前选中的交通方式（默认推荐项）
  const transportChoice =
    transport?.options.find((o) => o.mode === transportMode) || transport?.options[0] || null;

  // 往返交通段：首日去程 + 末日返程（跨城时返程从最后一个城市出发）
  const intercityLegs = useMemo<IntercityLegs | undefined>(() => {
    if (!transport || !transportChoice || !selectedCities.length) return undefined;
    const first = view === "manual" ? manualFirstCity : selectedCities[0];
    const last = view === "manual" ? manualLastCity : selectedCities[selectedCities.length - 1];
    const base = {
      mode: transportChoice.mode,
      label: transportChoice.label,
      hours: transportChoice.hours,
      cost: transportChoice.cost,
    };
    return {
      outbound: { ...base, from: transport.from, to: first, day: 1 },
      inbound: { ...base, from: last, to: transport.from, day: days },
    };
  }, [transport, transportChoice, selectedCities, days, view, manualFirstCity, manualLastCity]);

  // 城市联想：优先高德在线，失败/无结果时回退本地城市列表
  const citySearchTimer = useRef<number | undefined>(undefined);
  const citySearchSeq = useRef(0);
  const searchCity = (q: string) => {
    const term = q.trim();
    window.clearTimeout(citySearchTimer.current);
    // 本地模式只在内置城市里筛选，不请求高德
    if (dataSource === "local") {
      setCityOptions(term ? hotCities.filter((c) => c.includes(term)) : hotCities);
      return;
    }
    if (!term) {
      setCityOptions(hotCities);
      return;
    }
    // 输入防抖：高德个人 Key QPS 很低，连续输入只发最后一次请求
    citySearchTimer.current = window.setTimeout(() => {
      const seq = ++citySearchSeq.current;
      fetchAmapCity(term)
        .then((tips) => {
          if (citySearchSeq.current !== seq) return;
          const names = Array.from(new Set(tips.map((t) => t.name).filter(Boolean)));
          setCityOptions(names.length ? names : hotCities.filter((c) => c.includes(term)));
        })
        .catch(() => {
          if (citySearchSeq.current !== seq) return;
          setCityOptions(hotCities.filter((c) => c.includes(term)));
        });
    }, 250);
  };

  // 必去景点联想：只保留景点，不带美食 / 酒店 / 购物；候选框保留全部匹配项
  const searchPoi = (q: string) => {
    const term = q.trim();
    if (!term) {
      setPoiOptions(scenicOnly(pois).map((po) => po.name));
      setPoiBriefs([]);
      return;
    }
    // 离线模式或在线 Key 不可用：仅在已加载的离线景点里筛选，不请求高德
    if (dataSource === "local" || amapEnabled === false) {
      const hits = scenicOnly(pois).filter((po) => po.name.includes(term));
      setPoiOptions(hits.map((po) => po.name));
      setPoiBriefs(
        hits.map((po) => ({
          name: po.name,
          address: String(po.address || ""),
          category: po.category,
          rating: String(po.rating || ""),
          cost: Number(po.price_per_person) > 0 ? String(po.price_per_person) : "",
          openTime: String(po.open_hours || ""),
          photo: String(po.photo || ""),
        })),
      );
      return;
    }
    fetchAmapPoiBriefs(term, primaryCity)
      .then((list) => {
        const scenic = list.filter((x) => (x.category || "景点") === "景点");
        setPoiOptions(scenic.map((x) => x.name));
        setPoiBriefs(scenic);
      })
      .catch(() => {
        setPoiOptions([]);
        setPoiBriefs([]);
      });
  };

  const abortRef = useRef<AbortController | null>(null);
  /** 路线优化时传入的起始顺序（本地 2-opt 结果），避免与 setState 异步打架 */
  const optimizeBaseRef = useRef<ManualStop[] | null>(null);

  const handleRun = async () => {
    const isOptimize = runKindRef.current === "optimize";
    // 出行人群必选：按钮已禁用，这里静默拦截，不再弹提示
    if (!isOptimize && prefs.group.length === 0) return;
    // 出发城市未设置时只在开始规划时提示一次；离线模式无需城际交通，不提示
    if (!isOptimize && dataSource === "online" && !fromCity) {
      setError("请先在右上角「个人信息」中设置出发城市（精确到市级），再开始规划");
      return;
    }
    // AI 规划需要城市 + 日期；手动路线优化只需选点 ≥2 且日期已选（城市取自所选地点）
    if (isOptimize) {
      if ((optimizeBaseRef.current ?? manualStops).length < 2 || !startDate || !endDate) return;
    } else if (!tripReady) {
      return;
    }
    const optimizeBase = optimizeBaseRef.current ?? manualStops;
    optimizeBaseRef.current = null;
    const latest = { current: null as ItineraryView | null };
    setError(null);
    setEvents([]);
    setItinerary(null);
    setReplanItinerary(null);
    setReplanDetail(null);
    setStressDetail(null);
    setMetrics(null);
    setProposal(null);
    setAdjustNotice("");
    setRunning(true);

    // 根据运行类型拼最终 requirement（偏好 + 可选手动路线顺序 + 天气摘要 + 城际交通）
    const weatherSummary = summarizeWeather(weather);
    const dateNote = ` 出行日期：${startDate} 至 ${endDate}，共 ${days} 天。`;
    const transportNote =
      transport && transportChoice
        ? ` 城际交通：${transport.from} → ${transport.to}（${isOptimize ? "手动路线第一站" : "第一个目的地"}）约 ${transport.distance_km} 公里，已选择${transportChoice.label}（约 ${transportChoice.hours} 小时），请把去程安排在第一天、返程安排在最后一天。`
        : "";
    // 个人信息中的昵称 / 简介作为出行人上下文，帮助模型个性化安排
    const profileNote =
      profile && (profile.nickname || profile.bio)
        ? ` 出行人：${profile.nickname || profile.username}${profile.bio ? `，偏好：${profile.bio}` : ""}。`
        : "";
    // 手动路线未选城市时，城市取自所选地点（跨城取并集），供优化请求使用
    const stopCities = Array.from(new Set(optimizeBase.map((s) => s.city).filter(Boolean)));
    const runCity =
      isOptimize && !selectedCities.length ? stopCities.join(",") || city : city;
    const reqCityLabel =
      isOptimize && !selectedCities.length ? stopCities.join("、") || "自定义路线" : cityLabel;
    const finalReq =
      (runKindRef.current === "optimize"
        ? buildManualRouteRequirement(
            optimizeBase,
            reqCityLabel,
            days,
            prefs,
            requirementExtra,
            weatherSummary,
          )
        : buildPreferenceRequirement(prefs, cityLabel, days, requirementExtra, weatherSummary)) +
      dateNote +
      transportNote +
      profileNote;
    runKindRef.current = "plain";

    const controller = new AbortController();
    abortRef.current = controller;

    const dispatch = (e: StreamEvent) => {
      setEvents((prev) => [...prev, e]);
      switch (e.event) {
        case "solve":
          if (e.detail?.itinerary) {
            setItinerary(e.detail.itinerary);
            latest.current = e.detail.itinerary;
          }
          break;
        case "stress":
          setStressDetail(e.detail);
          break;
        case "replan":
          setReplanDetail(e.detail);
          if (e.detail?.itinerary) setReplanItinerary(e.detail.itinerary);
          break;
        case "metrics":
          setMetrics({
            constraint_pass_rate: e.constraint_pass_rate,
            hallucination_rate: e.hallucination_rate,
            resilience_score: e.resilience_score,
            total_cost: e.total_cost,
            item_count: e.item_count,
            fragile_points: e.fragile_points,
          });
          break;
        case "run_failed":
          setError(e.error || "运行失败");
          break;
      }
    };

    try {
      await runStream(
        {
          city: runCity,
          days,
          modelKey,
          requirement: finalReq,
          source: dataSource,
          group: prefs.group,
          pace: prefs.pace,
          afternoon_indoor: prefs.afternoon_indoor,
          must_have_lunch: prefs.must_have_lunch,
          must_visit: prefs.must_visit,
          avoid: prefs.avoid,
          transport_mode: view === "ai" ? prefs.transport_mode ?? undefined : transportMode ?? undefined,
          budget: prefs.budget,
        },
        dispatch,
        controller.signal,
      );
    } catch (err: any) {
      if (err?.name !== "AbortError") setError(err?.message || String(err));
    } finally {
      setRunning(false);
      abortRef.current = null;
      // 手动路线优化：先按 AI 顺序映射回已选景点，再按城市聚簇，避免跨城折返
      if (isOptimize) {
        const base = latest.current
          ? reorderStopsByItinerary(optimizeBase, latest.current)
          : optimizeBase;
        const next = optimizeStopsLocally(base);
        const prev = optimizeBase;
        // 顺序没变化就直接应用；有变化则先出提案，用户确认后再写入
        const moved: ProposalChange[] = [];
        const prevIndex = new Map(prev.map((s, i) => [s.id, i]));
        next.forEach((s, i) => {
          const p = prevIndex.get(s.id);
          if (p === undefined || p === i) return;
          moved.push({
            kind: "reorder",
            day: s.day,
            from: `${s.name}（原第 ${p + 1} 位）`,
            to: `第 ${i + 1} 位`,
            reason: "按城市聚簇、减少折返",
          });
        });
        if (!moved.length) {
          setManualStops(next);
          setManualItinerary(
            buildManualItinerary(next, cityLabel, days, {
              travelers: travelerCount,
              pois,
            }),
          );
        } else {
          setProposal({
            id: newProposalId("ai"),
            source: "ai",
            title: "AI 优化路线",
            summary: `AI 建议调整 ${moved.length} 个景点的顺序，确认后才会写入路线`,
            changes: moved,
            apply: () => {
              setManualStops(next);
              setManualItinerary(
                buildManualItinerary(next, cityLabel, days, {
                  travelers: travelerCount,
                  pois,
                }),
              );
            },
            undo: () => {
              setManualStops(prev);
              setManualItinerary(
                buildManualItinerary(prev, cityLabel, days, {
                  travelers: travelerCount,
                  pois,
                }),
              );
            },
          });
        }
      }
    }
  };

  /** 异常天气 → 生成「户外换室内」提案（确认后才应用） */
  const handleWeatherAdjust = () => {
    if (!itinerary) {
      setAdjustNotice("请先「开始规划」生成行程，再按天气调整");
      return;
    }
    const built = buildWeatherAdjustment({
      itinerary,
      weather,
      pois,
      startDate,
    });
    if (!built) {
      setAdjustNotice("当前行程没有可替换的户外项目（或天气暂无异常）");
      return;
    }
    setAdjustNotice("");
    const prev = itinerary;
    setProposal({
      id: newProposalId("weather"),
      source: "weather",
      title: built.title,
      summary: built.summary,
      changes: built.changes,
      apply: () => setItinerary(built.next),
      undo: () => setItinerary(prev),
    });
  };

  const handleOptimizeFromManual = (base?: ManualStop[]) => {
    // 手动模式无需先选目的地城市：只要选点 ≥2 且日期已选即可优化
    if ((base ?? manualStops).length < 2 || !startDate || !endDate) return;
    optimizeBaseRef.current = base ?? null;
    runKindRef.current = "optimize";
    handleRun();
  };

  const handleReset = () => {
    setEvents([]);
    setItinerary(null);
    setReplanItinerary(null);
    setReplanDetail(null);
    setStressDetail(null);
    setMetrics(null);
    setManualItinerary(null);
    setError(null);
    setProposal(null);
    setAdjustNotice("");
    // 恢复默认选择：城市 / 日期 / 偏好 / 手动路线
    setSelectedCities([]);
    setStartDate("");
    setEndDate("");
    setPrefs({
      ...defaultPreferences,
      group: [...defaultPreferences.group],
      must_visit: [...defaultPreferences.must_visit],
      avoid: [...defaultPreferences.avoid],
    });
    setRequirementExtra("");
    setManualStops([]);
    // 连本地草稿一起删除：刷新后不会把刚清掉的选择又恢复回来
    clearSession();
  };

  /** 切换视图：中止进行中的规划，重置目的地城市 / 日期，并清空另一个视图遗留的结果 */
  const handleViewChange = (next: View) => {
    if (next === view) return;
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    // 两个视图共用的临时状态
    setError(null);
    setProposal(null);
    setAdjustNotice("");
    // 表单恢复初始状态：目的地城市与出发/结束日期清空
    setSelectedCities([]);
    setStartDate("");
    setEndDate("");
    setPois([]);
    setPoiOptions([]);
    setPoiBriefs([]);
    setWeather([]);
    setTransport(null);
    setTransportMode(null);
    setTransportError("");
    if (next === "ai") {
      // 切回 AI 规划：清空手动路线的选点与行程
      setManualStops([]);
      setManualItinerary(null);
    } else {
      // 切到手动路线：清空 AI 生成的行程 / 指标 / 重规划结果
      setEvents([]);
      setItinerary(null);
      setReplanItinerary(null);
      setReplanDetail(null);
      setStressDetail(null);
      setMetrics(null);
    }
    setView(next);
  };

  // 手动行程卡跟随已选路线自动同步（拖拽排序 / 删除 / 改天 / 地图上移除）
  useEffect(() => {
    if (!manualItinerary) return;
    setManualItinerary(
      manualStops.length
        ? buildManualItinerary(manualStops, cityLabel, days, {
            travelers: travelerCount,
            pois,
          })
        : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualStops, cityLabel, days, travelerCount, pois]);

  // 手动模式：点地图标记 → 移除该 stop
  const handleMapPointClick = (mp: MapPoint) => {
    const id = mp.key.startsWith("manual-") ? mp.key.slice("manual-".length) : mp.key;
    setManualStops((prev) =>
      prev.filter((s) => s.id !== id).map((s, i) => ({ ...s, order: i })),
    );
  };

  /** 点击地图高亮点：未选中则加入路线，已选中则移除（再点一次取消选择） */
  const handleTogglePoi = useCallback(
    (po: PoiSnapshot) => {
      setManualStops((prev) => {
        const hit = prev.find((s) => s.id === po.id);
        if (hit) return prev.filter((s) => s.id !== po.id).map((s, i) => ({ ...s, order: i }));
        return [
          ...prev,
          {
            id: po.id,
            name: po.name,
            city: po.city || primaryCity,
            day: 1,
            order: prev.length,
            lat: po.lat,
            lng: po.lng,
            category: po.category,
            indoor: po.indoor,
            walking_minutes: po.walking_minutes,
            stairs: po.stairs,
            cost: Number(po.price_per_person) || 0,
            visit_minutes: po.visit_minutes,
          },
        ];
      });
    },
    [primaryCity],
  );

  const selectedStopIds = useMemo(
    () => new Set(manualStops.map((s) => s.id)),
    [manualStops],
  );

  // 地图打点：随视图切换数据源
  const aiItinerary = replanItinerary || itinerary;
  const aiMapPoints: MapPoint[] = useMemo(() => {
    if (!aiItinerary) return [];
    return sortItineraryItems(aiItinerary.items.filter((i) => !i.is_backup)).map((it, idx) => {
        const c = coordMap.get(it.poi);
        return {
          key: `${it.day}-${idx}-${it.poi}`,
          name: it.poi,
          day: it.day,
          start: it.start,
          end: it.end,
          lat: c?.lat,
          lng: c?.lng,
          indoor: c?.indoor ?? it.indoor,
          walking_min: it.walking_min,
        };
      });
  }, [aiItinerary, coordMap]);

  const manualMapPoints = useMemo(() => manualStopsToMapPoints(manualStops), [manualStops]);
  const mapPoints = view === "manual" ? manualMapPoints : aiMapPoints;

  const hasRun = events.length > 0 || running;

  return (
    <div className="app-shell">
      <TopBar
        nav={[
          { key: "ai", label: "AI 规划" },
          { key: "manual", label: "手动路线" },
        ]}
        active={view}
        onChange={(k) => handleViewChange(k as View)}
        user={user}
        onLogout={onLogout}
        dataSource={dataSource}
        onDataSourceChange={handleDataSourceChange}
        profileCity={profile?.city || ""}
        onOpenProfile={() => setProfileOpen(true)}
        chips={[{ text: running ? "规划中" : "就绪", tone: running ? "busy" : "ok" }]}
      />

      <div className="workspace">
        <main className="work-left">
          <div className="page-hero fade-up">
          <div className="page-eyebrow">
            <span className="page-eyebrow-dot" />
            途稳 · 韧性旅行规划
          </div>
          <h1 className="page-title">
            {view === "ai" ? "先认识你，再安排好这趟旅程" : "亲手排一条路线，交给 AI 校验"}
          </h1>
          <p className="page-sub">
            {view === "ai"
              ? "设置旅行偏好和出行天气，AI 会生成可验证的行程，并在地图上画出完整轨迹。"
              : "在右侧地图上搜索并点选地点即可组建路线，无需先选城市；支持拖拽排序与分配到每一天。"}
          </p>
        </div>

        <ControlPanel
          cities={selectedCities}
          setCities={setSelectedCities}
          cityOptions={cityOptions}
          onSearchCity={searchCity}
          startDate={startDate}
          setStartDate={handleStartDate}
          endDate={endDate}
          setEndDate={setEndDate}
          days={days}
          showCities={view === "ai"}
        />

          {dataSource === "online" && amapEnabled === false && (
            <div className="notice-line">
              在线模式尚未配置服务端高德 Web 服务 Key：当前只能使用内置数据。请在 .env 中填写 AMAP_KEY（Web 服务类型）并重启服务，即可拉取全部城市的全量 POI。
            </div>
          )}

          {/* AI 规划：城际交通在选完城市 / 日期后即可选择；手动路线则移到选完路线之后 */}
          {view === "ai" && (
            <>
              {dataSource === "online" && fromCity && transportTo && (
                <IntercityPanel
                  plan={transport}
                  mode={transportMode}
                  setMode={handleTransportModeChange}
                  loading={transportLoading}
                  error={transportError}
                />
              )}
            </>
          )}

          {/* 出行天气预报：两个视图共享，失败/无数据时组件内部不渲染 */}
            <WeatherForecastView
              forecasts={weather}
              onAdjust={view === "ai" && itinerary ? handleWeatherAdjust : undefined}
            />

            {adjustNotice && <div className="notice-line">{adjustNotice}</div>}

            {/* 改动确认卡片：天气调整 / AI 优化的提案先预览，确认后才生效 */}
            {proposal && (
              <ProposalCard proposal={proposal} onDismiss={() => setProposal(null)} />
            )}

            {/* AI 规划视图内容 */}
            {view === "ai" && (
              <>
                <PreferencePanel
                  prefs={prefs}
                  setPrefs={setPrefs}
                  pois={pois}
                  poiOptions={poiOptions}
                  poiBriefs={poiBriefs}
                  onSearchPoi={searchPoi}
                  extra={requirementExtra}
                  setExtra={setRequirementExtra}
                  onRun={handleRun}
                  onReset={handleReset}
                  running={running}
                  canRun={tripReady && prefs.group.length > 0}
                />

                {error && (
                  <div className="banner-err">
                    <span>⚠️</span>
                    <span>{error}</span>
                  </div>
                )}

                {metrics && <MetricsStrip metrics={metrics} />}

                {itinerary && (
                  <>
                    <ItineraryTimeline
                      title="生成行程"
                      itinerary={itinerary}
                      pois={pois}
                      intercity={intercityLegs}
                      onEdit={setItinerary}
                    />
                    <BudgetPanel
                      itinerary={itinerary}
                      pois={pois}
                      intercity={intercityLegs}
                      budget={prefs.budget}
                      travelers={travelerCount}
                    />
                    <ExportBar itinerary={itinerary} startDate={startDate} city={cityLabel} />
                  </>
                )}

                {replanDetail && replanItinerary && (
                  <ReplanPanel
                    detail={replanDetail}
                    base={itinerary}
                    replanned={replanItinerary}
                  />
                )}

                {!hasRun && (
                  <div className="glass empty-state fade-up">
                    <div className="big">🧭</div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-2)" }}>
                      还没有运行记录
                    </div>
                    <div style={{ fontSize: 12.5, marginTop: 6 }}>
                      设置旅行偏好，点击「开始规划」查看 Agent 实时执行过程与轨迹地图
                    </div>
                  </div>
                )}
              </>
            )}

            {/* 手动路线视图内容 */}
            {view === "manual" && (
              <>
                <ManualRoute
                  city={selectedCities.join("、")}
                  days={days}
                  stops={manualStops}
                  setStops={setManualStops}
                  onApplyItinerary={setManualItinerary}
                  onOptimize={handleOptimizeFromManual}
                  onReset={handleReset}
                  running={running}
                  pois={pois}
                  travelers={travelerCount}
                />

                {/* 手动路线：选完路线后才出现城际交通，目的地 = 路线第一站 */}
                {dataSource === "online" && fromCity && !orderedManualStops.length && (
                  <div className="notice-line">
                    先从上方选好景点并排顺序，再选择从 {fromCity} 到路线第一站的城际交通方式。
                  </div>
                )}
                {dataSource === "online" && fromCity && transportTo && (
                  <>
                    <div className="intercity-anchor">
                      路线第一站：<b>{orderedManualStops[0]?.name || transportTo}</b>
                      {orderedManualStops[0]?.city && orderedManualStops[0].city !== transportTo
                        ? `（${orderedManualStops[0].city}）`
                        : ""}
                      ，以下为 {fromCity} → {transportTo} 的出行方式
                    </div>
                    <IntercityPanel
                      plan={transport}
                      mode={transportMode}
                      setMode={handleTransportModeChange}
                      loading={transportLoading}
                      error={transportError}
                    />
                  </>
                )}

                {manualItinerary && (
                  <>
                    <ItineraryTimeline
                      title="手动路线行程"
                      itinerary={manualItinerary}
                      pois={pois}
                      intercity={intercityLegs}
                    />
                    <BudgetPanel
                      itinerary={manualItinerary}
                      pois={pois}
                      intercity={intercityLegs}
                      budget={prefs.budget}
                      travelers={travelerCount}
                    />
                    <ExportBar itinerary={manualItinerary} startDate={startDate} city={cityLabel} />
                  </>
                )}
              </>
            )}
        </main>

        {/* 右侧地图：滚动时固定跟随（携程式左右布局） */}
        <aside className="work-map">
          <MapView
            city={view === "manual" ? selectedCities[0] || "" : primaryCity}
            points={mapPoints}
            loading={view === "ai" && running && !itinerary}
            onPointClick={view === "manual" ? handleMapPointClick : undefined}
            manualMode={view === "manual"}
            source={dataSource}
            selectedIds={selectedStopIds}
            onTogglePoi={handleTogglePoi}
          />
        </aside>
      </div>

      {/* 个人信息设置：昵称 / 所属城市（出发城市）/ 简介 */}
      <ProfileModal
        open={profileOpen}
        profile={profile}
        onClose={() => setProfileOpen(false)}
        onSaved={(p) => setProfile(p)}
      />
    </div>
  );
}
