/**
 * 地图英雄区：行程轨迹可视化。
 *
 * 两种渲染模式：
 *   1. 配置了 VITE_AMAP_KEY → 加载高德 JS API 2.0 真实瓦片，按 itinerary 打点，
 *      相邻点之间调用后端代理的高德路径规划（walking）画真实路线 polyline。
 *   2. 未配置 Key / 加载失败 → 降级为自绘 SVG 示意图：把本地 POI 经纬度投影到平面，
 *      画编号标记 + 连线，演示零依赖也能出图。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchAmapGeocode, fetchAmapLocate, fetchAmapRoute } from "../api";
import type { DataSource, MapPoint, PoiSnapshot } from "../api";
import { dayColor } from "../meta";
import MapPoiSearch, { type LocateFeedback } from "./MapPoiSearch";

type Mode = "loading" | "amap" | "schematic" | "empty";

/** 与携程地图一致：低比例尺不铺单点，放大到城市级才显示高亮标记 */
const HIGHLIGHT_MIN_ZOOM = 11;

/** 高德 Marker 内容是 HTML 字符串，POI 名称必须转义，避免把接口文本当标签执行 */
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
  );
}

/** 高亮标记：平时只显示名称，悬停才展开完整信息（详情不占页面空间） */
function poiPinHtml(po: PoiSnapshot, selected: boolean): string {
  const info = [
    `${esc(po.category || "地点")}${po.city ? ` · ${esc(po.city)}` : ""}`,
    Number(po.price_per_person) > 0 ? `人均 ¥${Number(po.price_per_person)}` : "",
    po.rating ? `⭐ ${esc(po.rating)}` : "",
    po.open_hours ? `🕘 ${esc(po.open_hours)}` : "",
    po.address ? esc(po.address) : "",
  ].filter(Boolean);
  // 只铺小圆点，名称 / 评分 / 营业时间等详情悬停才出现，避免上百个标签盖住地图
  return `<div class="amap-poi-pin${selected ? " selected" : ""}" title="${esc(po.name + " · " + info.join(" · "))}">
    <span class="amap-poi-dot">${selected ? "✓" : "+"}</span>
    <div class="amap-poi-tip"><b>${esc(po.name)}</b>${info.map((x) => `<span>${x}</span>`).join("")}<em>点击${selected ? "移出" : "加入"}路线</em></div>
  </div>`;
}

declare global {
  interface Window {
    _AMapSecurityConfig?: { securityJsCode?: string };
    AMapLoader?: { load: (opts: any) => Promise<any> };
    AMap?: any;
  }
}

/** 读取前端环境变量：必须用静态写法才能被 Rsbuild define 替换（VITE_ 前缀由 web/.env 注入） */

/* ───────────────────────── 高德 JS API 加载（单例缓存） ───────────────────────── */
let amapLoadPromise: Promise<any> | null = null;
function loadAmapJs(key: string, securityCode: string): Promise<any> {
  if (window.AMap) return Promise.resolve(window.AMap);
  if (amapLoadPromise) return amapLoadPromise;
  amapLoadPromise = new Promise((resolve, reject) => {
    // 安全密钥必须在 JSAPI 加载前设置
    window._AMapSecurityConfig = { securityJsCode: securityCode || undefined };
    const doLoad = () => {
      if (!window.AMapLoader) {
        reject(new Error("AMapLoader 未就绪"));
        return;
      }
      window.AMapLoader.load({
        key,
        version: "2.0",
        plugins: ["AMap.Scale", "AMap.ToolBar"],
      })
        .then((AMap: any) => resolve(AMap))
        .catch((e: any) => reject(e));
    };
    if (window.AMapLoader) {
      doLoad();
    } else {
      const s = document.createElement("script");
      s.src = "https://webapi.amap.com/loader.js";
      s.async = true;
      s.onload = doLoad;
      s.onerror = () => reject(new Error("高德 loader.js 加载失败"));
      document.head.appendChild(s);
    }
  });
  return amapLoadPromise;
}

/* ───────────────────────── 路线 polyline 解析 ───────────────────────── */
function extractPath(j: any): [number, number][] {
  const steps = j?.route?.paths?.[0]?.steps || [];
  const out: [number, number][] = [];
  for (const s of steps) {
    const pl: string = s.polyline || "";
    for (const pair of pl.split(";")) {
      const [lng, lat] = pair.split(",");
      const x = Number(lng);
      const y = Number(lat);
      if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
    }
  }
  return out;
}

/* ───────────────────────── 主组件 ───────────────────────── */
export default function MapView({
  city,
  points,
  loading,
  onPointClick,
  manualMode,
  source = "online",
  selectedIds,
  onTogglePoi,
}: {
  city: string;
  points: MapPoint[];
  loading?: boolean;
  /** 手动模式下点击地图标记的回调（如移除该点）；不传则标记不可点 */
  onPointClick?: (p: MapPoint) => void;
  /** 手动路线：地图内搜索并点击高亮点切换选中 */
  manualMode?: boolean;
  source?: DataSource;
  selectedIds?: Set<string>;
  /** 点击高亮点：已选则移出路线，未选则加入路线 */
  onTogglePoi?: (poi: PoiSnapshot) => void;
}) {
  // 静态访问：Rsbuild define 只能替换字面量形式 import.meta.env.XXX
  const jsKey = (import.meta.env.VITE_AMAP_KEY || "").trim();
  const secCode = (import.meta.env.VITE_AMAP_SECURITY_CODE || "").trim();

  const [mode, setMode] = useState<Mode>(jsKey ? "loading" : "schematic");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const [searchResults, setSearchResults] = useState<PoiSnapshot[]>([]);
  const [mapCenter, setMapCenter] = useState<[number, number] | null>(null);
  const [mapZoom, setMapZoom] = useState(11);

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const amapLibRef = useRef<any>(null);
  const overlaysRef = useRef<any[]>([]);
  const searchOverlaysRef = useRef<any[]>([]);
  /** 记录已自动聚焦过的结果集，避免缩放回调重复触发聚焦 */
  const fittedResultsRef = useRef<PoiSnapshot[] | null>(null);

  // 仅保留有经纬度的点
  const pts = useMemo(
    () => points.filter((p) => typeof p.lat === "number" && typeof p.lng === "number"),
    [points],
  );

  // 决定渲染模式
  useEffect(() => {
    let alive = true;
    if (!jsKey) {
      setMode("schematic");
      return;
    }
    setMode("loading");
    loadAmapJs(jsKey, secCode)
      .then((AMap) => {
        if (!alive) return;
        amapLibRef.current = AMap;
        setMode("amap");
      })
      .catch((e) => {
        if (!alive) return;
        console.warn("[MapView] 高德地图加载失败，降级示意图：", e);
        setErrMsg(e?.message || String(e));
        setMode("schematic");
      });
    return () => {
      alive = false;
    };
  }, [jsKey, secCode]);

  // 切回 AI 视图时清掉搜索候选标记，避免残留青色点
  useEffect(() => {
    if (!manualMode) setSearchResults([]);
  }, [manualMode]);

  // 没有行程点时也要自动展示地图：先按城市名定位中心（未选城市时保持默认中心）
  useEffect(() => {
    if (pts.length || !city) return;
    let alive = true;
    fetchAmapGeocode(city)
      .then((j) => {
        const [lngS, latS] = String(j?.geocodes?.[0]?.location || "").split(",");
        const lng = Number(lngS);
        const lat = Number(latS);
        if (alive && Number.isFinite(lng) && Number.isFinite(lat)) setMapCenter([lng, lat]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [manualMode, city, pts.length]);

  // 高德模式：创建地图 + 打点 + 画路线
  useEffect(() => {
    if (mode !== "amap") return;
    const AMap = amapLibRef.current;
    if (!AMap || !containerRef.current) return;
    if (pts.length === 0 && !manualMode) {
      clearOverlays();
      return;
    }

    let cancelled = false;

    (async () => {
      // 1. 懒创建地图实例
      if (!mapRef.current) {
        const avgLng = pts.length
          ? pts.reduce((s, p) => s + (p.lng as number), 0) / pts.length
          : mapCenter?.[0] ?? 116.397;
        const avgLat = pts.length
          ? pts.reduce((s, p) => s + (p.lat as number), 0) / pts.length
          : mapCenter?.[1] ?? 39.908;
        mapRef.current = new AMap.Map(containerRef.current, {
          zoom: pts.length ? 12 : 11,
          center: [avgLng, avgLat],
          viewMode: "2D",
          mapStyle: "amap://styles/normal",
        });
        mapRef.current.addControl(new AMap.Scale());
        mapRef.current.on("zoomend", () => setMapZoom(mapRef.current?.getZoom?.() || 11));
        setMapZoom(mapRef.current.getZoom?.() || 11);
      }
      const map = mapRef.current;
      if (!pts.length && mapCenter) {
        try {
          map.setCenter(mapCenter);
        } catch {
          /* ignore */
        }
      }
      clearOverlays();

      // 2. 标记点
      pts.forEach((p, i) => {
        const color = dayColor(p.day);
        const badge = `
          <div class="amap-marker-pin">
            <div class="amap-marker-badge" style="background:${color}">${i + 1}</div>
            <div class="amap-marker-label">${p.name}</div>
          </div>`;
        const marker = new AMap.Marker({
          position: [p.lng, p.lat],
          content: badge,
          anchor: "bottom-center",
          zIndex: 100 + i,
        });
        marker.setMap(map);
        if (onPointClick) marker.on("click", () => onPointClick(p));
        overlaysRef.current.push(marker);
      });

      // 3. 相邻点之间画路线（优先高德规划 polyline，失败则直线）
      const pairs: { a: MapPoint; b: MapPoint; color: string }[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        pairs.push({ a: pts[i], b: pts[i + 1], color: dayColor(pts[i].day) });
      }
      const segPaths = await Promise.all(
        pairs.map(async ({ a, b }) => {
          try {
            const origin = `${a.lng},${a.lat}`;
            const destination = `${b.lng},${b.lat}`;
            const j = await fetchAmapRoute(origin, destination, "walking");
            const path = extractPath(j);
            return path.length >= 2 ? path : ([
              [a.lng, a.lat],
              [b.lng, b.lat],
            ] as [number, number][]);
          } catch {
            return [
              [a.lng, a.lat],
              [b.lng, b.lat],
            ] as [number, number][];
          }
        }),
      );
      if (cancelled) return;

      segPaths.forEach((path, i) => {
        if (!path || path.length < 2) return;
        const line = new AMap.Polyline({
          path,
          strokeColor: pairs[i].color,
          strokeWeight: 5,
          strokeOpacity: 0.85,
          lineJoin: "round",
          lineCap: "round",
          showDir: true,
        });
        line.setMap(map);
        overlaysRef.current.push(line);
      });

      // 4. 自适应视野
      try {
        map.setFitView(overlaysRef.current, false, [70, 70, 70, 70]);
      } catch {
        /* ignore */
      }
    })();

    function clearOverlays() {
      overlaysRef.current.forEach((o) => {
        try {
          o.setMap(null);
        } catch {
          /* ignore */
        }
      });
      overlaysRef.current = [];
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, pts, manualMode, mapCenter]);

  // 手动模式：高亮结果落到地图上；比例尺过小时只提示、不铺单点
  useEffect(() => {
    if (mode !== "amap") return;
    const AMap = amapLibRef.current;
    const map = mapRef.current;
    if (!AMap || !map) return;
    searchOverlaysRef.current.forEach((o) => {
      try {
        o.setMap(null);
      } catch {
        /* ignore */
      }
    });
    searchOverlaysRef.current = [];

    const valid = searchResults.filter(
      (po) => Number.isFinite(po.lat) && Number.isFinite(po.lng),
    );

    // 新结果集：自动聚焦到候选中心并保证达到可见级别；不再 setFitView 把点缩到看不见
    if (fittedResultsRef.current !== searchResults) {
      fittedResultsRef.current = searchResults;
      if (valid.length) {
        const lng = valid.reduce((s, po) => s + Number(po.lng), 0) / valid.length;
        const lat = valid.reduce((s, po) => s + Number(po.lat), 0) / valid.length;
        try {
          map.setZoomAndCenter(13, [lng, lat]);
        } catch {
          /* ignore */
        }
      }
    }

    // 低比例尺：携程式处理——不铺单点，由搜索面板提示放大查看
    if (mapZoom < HIGHLIGHT_MIN_ZOOM) return;

    valid.forEach((po) => {
      const marker = new AMap.Marker({
        position: [po.lng, po.lat],
        content: poiPinHtml(po, !!selectedIds?.has(po.id)),
        anchor: "bottom-center",
        zIndex: 80,
      });
      marker.on("click", () => onTogglePoi?.(po));
      marker.setMap(map);
      searchOverlaysRef.current.push(marker);
    });
    return () => {
      searchOverlaysRef.current.forEach((o) => {
        try {
          o.setMap(null);
        } catch {
          /* ignore */
        }
      });
      searchOverlaysRef.current = [];
    };
  }, [mode, searchResults, onTogglePoi, selectedIds, mapZoom]);

  // 卸载时销毁地图
  useEffect(() => {
    return () => {
      if (mapRef.current) {
        try {
          mapRef.current.destroy();
        } catch {
          /* ignore */
        }
        mapRef.current = null;
      }
    };
  }, []);

  /** 搜索框回车：把视野跳到指定城市 / 省份 / 景点（后端做行政区优先的三级判定） */
  const locate = useCallback(
    async (term: string): Promise<LocateFeedback> => {
      const t = term.trim();
      if (!t) return { ok: false, msg: "请输入城市或地点" };
      try {
        const r = await fetchAmapLocate(t);
        if (!r?.found) return { ok: false, msg: r?.error || `没有找到「${t}」` };
        const [lng, lat] = String(r.center || "").split(",").map(Number);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
          return { ok: false, msg: `没有找到「${t}」` };
        }
        // 地图首次加载可能慢于用户回车：等待就绪，不让用户手动重试
        const deadline = Date.now() + 8000;
        while (!mapRef.current && mode === "amap" && Date.now() < deadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 120));
        }
        const map = mapRef.current;
        if (!map) {
          if (mode !== "amap") {
            // 无高德 Key 的降级示意图：移动投影中心即可
            setMapCenter([lng, lat]);
            return { ok: true, msg: `已定位：${r.name || t}`, scope: r.scope };
          }
          return { ok: false, msg: "地图加载失败，请刷新页面重试" };
        }
        // setZoomAndCenter(zoom, center, immediately, duration)：带过渡动画跳到目标
        map.setZoomAndCenter(Number(r.zoom) || 12, [lng, lat], false, 600);
        return { ok: true, msg: `已定位：${r.name || t}`, scope: r.scope };
      } catch (e: any) {
        return { ok: false, msg: e?.message || "定位失败" };
      }
    },
    [mode],
  );

  /** 点击搜索结果行：把地图视野移到该 POI */
  const focusPoi = useCallback((po: PoiSnapshot) => {
    const map = mapRef.current;
    if (!map || !Number.isFinite(po.lng) || !Number.isFinite(po.lat)) return;
    try {
      map.setZoomAndCenter(15, [po.lng, po.lat], false, 500);
    } catch {
      /* ignore */
    }
  }, []);

  const hasPoints = pts.length > 0;
  const daysPresent = useMemo(() => {
    const set = new Set<number>();
    pts.forEach((p) => set.add(p.day));
    return Array.from(set).sort((a, b) => a - b);
  }, [pts]);

  const modeLabel =
    mode === "amap"
      ? "高德地图"
      : mode === "schematic"
        ? jsKey
          ? "示意图（高德加载失败）"
          : "示意图 · 未配置高德 Key"
        : "加载中…";

  return (
    <section className="map-hero fade-up">
      {/* 高德容器 / 示意 SVG 互斥显示 */}
      <div
        id="amap-container"
        ref={containerRef}
        style={{ display: mode === "amap" ? "block" : "none" }}
      />
      {mode === "schematic" && (
        <div className="map-fallback">
          <SchematicMap
            points={pts}
            candidates={manualMode ? searchResults : undefined}
            selectedIds={selectedIds}
            center={mapCenter}
            onPointClick={onPointClick}
            onCandidateClick={manualMode ? onTogglePoi : undefined}
          />
        </div>
      )}

      {/* 加载 / 空态 */}
      {mode === "loading" && (
        <div className="map-loading">
          <div className="map-spinner" />
          <div>正在加载高德地图…</div>
        </div>
      )}
      {/* 地图始终展示；未生成行程时只给一句轻提示，不再用空态盖住底图 */}
      {mode !== "loading" && !hasPoints && !manualMode && (
        <div className="map-idle-tip">
          {loading ? "Agent 规划中，完成后在此绘制轨迹…" : "选择城市并开始规划，轨迹会自动绘制在这里"}
          {mode === "schematic" && !jsKey ? " · 配置 VITE_AMAP_KEY 可显示真实瓦片" : ""}
          {errMsg ? ` · ${errMsg}` : ""}
        </div>
      )}

      <div className="map-overlay" />

      <div className="map-badge">{modeLabel}</div>

      {manualMode && onTogglePoi && (
        <MapPoiSearch
          city={city}
          source={source}
          selectedIds={selectedIds || new Set<string>()}
          onLocate={locate}
          onResultsChange={setSearchResults}
          zoomEnough={mapZoom >= HIGHLIGHT_MIN_ZOOM}
        />
      )}

      {hasPoints && daysPresent.length > 0 && (
        <div className="map-legend">
          {daysPresent.map((d) => (
            <span className="legend-item" key={d}>
              <span className="legend-swatch" style={{ background: dayColor(d) }} />
              Day {d}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/* ───────────────────────── 降级：自绘 SVG 示意地图 ───────────────────────── */
function SchematicMap({
  points,
  candidates,
  selectedIds,
  center,
  onPointClick,
  onCandidateClick,
}: {
  points: MapPoint[];
  /** 手动模式高亮结果：青色候选点，点击切换选中 */
  candidates?: PoiSnapshot[];
  selectedIds?: Set<string>;
  /** 无行程点时以城市中心为底图中心 */
  center?: [number, number] | null;
  onPointClick?: (p: MapPoint) => void;
  onCandidateClick?: (poi: PoiSnapshot) => void;
}) {
  const W = 1000;
  const H = 1000;
  const pad = 80;

  const validCandidates = (candidates || []).filter(
    (po) => Number.isFinite(po.lat) && Number.isFinite(po.lng),
  );
  const allCoords = [
    ...points.filter((p) => typeof p.lat === "number" && typeof p.lng === "number"),
    ...validCandidates,
  ];
  const fallbackCenter =
    center && Number.isFinite(center[0]) && Number.isFinite(center[1])
      ? { lat: center[1], lng: center[0] }
      : { lat: 39.9, lng: 116.4 };
  const lats = (allCoords.length ? allCoords : [fallbackCenter]).map((p) => p.lat as number);
  const lngs = (allCoords.length ? allCoords : [fallbackCenter]).map((p) => p.lng as number);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const rangeLat = Math.max(maxLat - minLat, 0.0001);
  const rangeLng = Math.max(maxLng - minLng, 0.0001);
  // 保留比例：取较大的跨度填满可用区域
  const span = Math.max(rangeLat, rangeLng) * 1.15;
  const midLat = (minLat + maxLat) / 2;
  const midLng = (minLng + maxLng) / 2;

  const project = (lng: number, lat: number): [number, number] => {
    const x = pad + ((lng - (midLng - span / 2)) / span) * (W - pad * 2);
    // 纬度越大越靠上 → y 反转
    const y = pad + ((midLat + span / 2 - lat) / span) * (H - pad * 2);
    return [x, y];
  };

  const projected = points.map((p) => ({ p, xy: project(p.lng as number, p.lat as number) }));

  // 连线（相邻点，按天着色）
  const segments: { d: string; color: string }[] = [];
  for (let i = 0; i < projected.length - 1; i++) {
    const a = projected[i].xy;
    const b = projected[i + 1].xy;
    segments.push({ d: `M${a[0]},${a[1]} L${b[0]},${b[1]}`, color: dayColor(points[i].day) });
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="schemBg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f8fafc" />
          <stop offset="100%" stopColor="#e7eef8" />
        </linearGradient>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="markerShadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#000" floodOpacity="0.45" />
        </filter>
      </defs>

      <rect x="0" y="0" width={W} height={H} fill="url(#schemBg)" />

      {/* 参考网格 */}
      {Array.from({ length: 9 }).map((_, i) => (
        <line
          key={`v${i}`}
          x1={(W / 9) * (i + 1)}
          y1={0}
          x2={(W / 9) * (i + 1)}
          y2={H}
          stroke="rgba(15,23,42,0.07)"
          strokeWidth="1"
        />
      ))}
      {Array.from({ length: 6 }).map((_, i) => (
        <line
          key={`h${i}`}
          x1={0}
          y1={(H / 6) * (i + 1)}
          x2={W}
          y2={(H / 6) * (i + 1)}
          stroke="rgba(15,23,42,0.07)"
          strokeWidth="1"
        />
      ))}

      {/* 连线 */}
      {segments.map((s, i) => (
        <path
          key={i}
          d={s.d}
          fill="none"
          stroke={s.color}
          strokeWidth="4"
          strokeOpacity="0.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          filter="url(#glow)"
        />
      ))}

      {/* 手动模式：分类高亮的候选点。名称 / 详情只在悬停时出现，不占用地图空间 */}
      {validCandidates.map((po) => {
        const xy = project(po.lng, po.lat);
        const picked = !!selectedIds?.has(po.id);
        const detail = [
          `${po.category || "地点"}${po.city ? ` · ${po.city}` : ""}`,
          Number(po.price_per_person) > 0 ? `人均 ¥${po.price_per_person}` : "",
          po.open_hours || "",
          po.address || "",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <g
            key={`cand-${po.id}`}
            className="schem-poi-node"
            onClick={() => onCandidateClick?.(po)}
            style={{ cursor: onCandidateClick ? "pointer" : "default" }}
          >
            <title>{`${po.name} · ${detail}（点击${picked ? "移出" : "加入"}路线）`}</title>
            <circle
              cx={xy[0]}
              cy={xy[1]}
              r="12"
              fill={picked ? "#10b981" : "#06b6d4"}
              stroke="#fff"
              strokeWidth="2.5"
              filter="url(#markerShadow)"
            />
            <text
              x={xy[0]}
              y={xy[1] + 1}
              textAnchor="middle"
              dominantBaseline="central"
              fill="#fff"
              fontSize="12"
              fontWeight="800"
            >
              {picked ? "✓" : "+"}
            </text>
            <g className="schem-poi-tip" transform={`translate(${xy[0] + 14}, ${xy[1] - 14})`}>
              <rect
                x="0"
                y="-14"
                width={Math.max(po.name.length * 12 + 24, detail.length * 8 + 24, 80)}
                height="40"
                rx="7"
                fill="rgba(255,255,255,0.96)"
                stroke="rgba(6,182,212,0.6)"
              />
              <text x="9" y="0" fill="#0f172a" fontSize="12" fontWeight="700">
                {po.name}
              </text>
              <text x="9" y="16" fill="#475569" fontSize="10">
                {detail.slice(0, 42)}
              </text>
            </g>
          </g>
        );
      })}

      {/* 标记点 + 标签 */}
      {projected.map(({ p, xy }, i) => {
        const color = dayColor(p.day);
        const labelX = xy[0] + 16;
        const labelY = xy[1] - 14;
        return (
          <g
            key={p.key || i}
            onClick={() => onPointClick?.(p)}
            style={{ cursor: onPointClick ? "pointer" : "default" }}
          >
            <circle
              cx={xy[0]}
              cy={xy[1]}
              r="15"
              fill={color}
              stroke="#fff"
              strokeWidth="3"
              filter="url(#markerShadow)"
            />
            <text
              x={xy[0]}
              y={xy[1] + 1}
              textAnchor="middle"
              dominantBaseline="central"
              fill="#fff"
              fontSize="13"
              fontWeight="800"
            >
              {i + 1}
            </text>
            <g transform={`translate(${labelX}, ${labelY})`}>
              <rect
                x="0"
                y="-12"
                width={Math.max(p.name.length * 13 + 14, 40)}
                height="20"
                rx="6"
                fill="rgba(255,255,255,0.94)"
                stroke="rgba(15,23,42,0.12)"
              />
              <text
                x="8"
                y="2"
                fill="#0f172a"
                fontSize="11.5"
                fontWeight="600"
                dominantBaseline="central"
              >
                {p.name}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
