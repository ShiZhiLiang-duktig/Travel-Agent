/**
 * 分段交通：计算「同一天内相邻两个行程项」的步行距离与时长。
 *
 * 策略：
 *   1. 优先调后端代理的高德路径规划（/api/amap/route）
 *   2. 结果按起终点坐标进程内缓存，inflight 去重，避免重复请求
 *   3. 高德未配置 / 请求失败 → 用球面直线距离 × 1.3 估算，按 4.5 km/h 折算分钟
 *   4. 直线距离 > 50 km 视为跨城段，不请求高德（省配额），直接估算
 */
import { useEffect, useMemo, useState } from "react";
import type { ItineraryView, PoiSnapshot } from "./api";
import { fetchAmapRoute } from "./api";
import { haversineKm, sortItineraryItems } from "./route-utils";

export interface SegmentInfo {
  km: number;
  minutes: number;
  source: "amap" | "estimate";
}

type LatLng = { lat: number; lng: number };

/** 进程内缓存（坐标对 → 分段结果） */
const cache = new Map<string, SegmentInfo>();
const inflight = new Map<string, Promise<SegmentInfo>>();

const WALK_KMH = 4.5;

/** 直线距离 → 步行估算（乘 1.3 近似路网绕行） */
function estimate(a: LatLng, b: LatLng): SegmentInfo {
  const km = haversineKm(a, b) * 1.3;
  return { km, minutes: Math.max(1, Math.round((km / WALK_KMH) * 60)), source: "estimate" };
}

/** 解析高德 walking / driving 返回：route.paths[0].distance(米) / duration(秒) */
function parseAmap(j: any): SegmentInfo | null {
  const path = j?.route?.paths?.[0];
  if (!path) return null;
  const km = Number(path.distance) / 1000;
  const sec = Number(path.duration);
  if (!Number.isFinite(km) || !Number.isFinite(sec)) return null;
  return { km, minutes: Math.max(1, Math.round(sec / 60)), source: "amap" };
}

async function loadSegment(a: LatLng, b: LatLng): Promise<SegmentInfo> {
  const est = estimate(a, b);
  const key = `${a.lng},${a.lat}->${b.lng},${b.lat}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (est.km > 50) {
    cache.set(key, est);
    return est;
  }
  let p = inflight.get(key);
  if (!p) {
    p = fetchAmapRoute(`${a.lng},${a.lat}`, `${b.lng},${b.lat}`, "walking")
      .then((j) => parseAmap(j) ?? est)
      .catch(() => est)
      .then((info) => {
        cache.set(key, info);
        inflight.delete(key);
        return info;
      });
    inflight.set(key, p);
  }
  return p;
}

/** 用 POI 快照把行程项名称映射到坐标（精确优先，再做一次包含匹配） */
function buildCoordFinder(pois: PoiSnapshot[]) {
  const exact = new Map<string, LatLng>();
  pois.forEach((p) => {
    if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) {
      exact.set(p.name, { lat: p.lat, lng: p.lng });
    }
  });
  return (name: string): LatLng | null => {
    const hit = exact.get(name);
    if (hit) return hit;
    const loose = pois.find(
      (p) =>
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lng) &&
        (name.includes(p.name) || p.name.includes(name)),
    );
    return loose ? { lat: loose.lat, lng: loose.lng } : null;
  };
}

/** 行程项在 UI 中的稳定 key（与 ItineraryTimeline 渲染顺序一致） */
export function segmentKey(day: number, start: string, poi: string): string {
  return `${day}-${start}-${poi}`;
}

/**
 * 计算整份行程的分段信息。
 * 返回 map：segmentKey(day, start, poi) → 上一项到本项的分段。
 */
export function useItinerarySegments(
  itinerary: ItineraryView | null,
  pois: PoiSnapshot[] | undefined,
): Record<string, SegmentInfo> {
  const coords = useMemo(() => {
    if (!itinerary || !pois?.length) return [];
    const find = buildCoordFinder(pois);
    const byDay = new Map<number, typeof itinerary.items>();
    sortItineraryItems(itinerary.items.filter((i) => !i.is_backup)).forEach((i) => {
        if (!byDay.has(i.day)) byDay.set(i.day, []);
        byDay.get(i.day)!.push(i);
      });
    const out: { key: string; a: LatLng; b: LatLng }[] = [];
    byDay.forEach((items, day) => {
      for (let i = 1; i < items.length; i++) {
        const a = find(items[i - 1].poi);
        const b = find(items[i].poi);
        if (!a || !b) continue;
        out.push({ key: segmentKey(day, items[i].start, items[i].poi), a, b });
      }
    });
    return out;
  }, [itinerary, pois]);

  const [map, setMap] = useState<Record<string, SegmentInfo>>({});

  useEffect(() => {
    if (!coords.length) {
      setMap({});
      return;
    }
    let alive = true;
    Promise.all(
      coords.map(async (c) => ({ key: c.key, info: await loadSegment(c.a, c.b) })),
    ).then((list) => {
      if (!alive) return;
      const next: Record<string, SegmentInfo> = {};
      list.forEach((x) => (next[x.key] = x.info));
      setMap(next);
    });
    return () => {
      alive = false;
    };
  }, [coords]);

  return map;
}
