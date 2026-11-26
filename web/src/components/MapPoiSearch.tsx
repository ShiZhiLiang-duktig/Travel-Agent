/**
 * 手动路线地图上的轻量搜索条：
 *   1. 先输入地点名称并按回车定位地图（城市 / 景区均可），定位成功后才启用分类按钮；
 *   2. 点击「景点 / 酒店 / 美食 …」→ 直接按定位城市拉取该分类全部 POI 并高亮到地图；
 *   3. 再次点击同一分类取消高亮；
 *   4. 高亮点平时只显示名称，悬停才展开详情；点击则加入 / 移出路线；
 *   5. 搜索框内没有按钮、不铺结果列表，不占用地图空间。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { searchPois, type DataSource, type PoiSnapshot } from "../api";
import { CATEGORY_FILTERS, CATEGORY_ICON, CATEGORY_TO_POI } from "../meta";

/** 定位反馈：由地图侧实现，返回提示文案与新的搜索作用域 */
export interface LocateFeedback {
  ok: boolean;
  msg: string;
  scope?: string;
}

/** 行政区简称归一：北京市 → 北京，避免会话回填时误判为换城市 */
function normPlace(name: string): string {
  return String(name || "")
    .replace(/特别行政区$/, "")
    .replace(/(壮族|维吾尔|回族)?自治区$/, "")
    .replace(/[省市县区]$/, "")
    .trim();
}

/** 分类匹配：内部分类优先，机场 / 火车站再用名称兜底 */
function matchCategory(cat: string, po: PoiSnapshot): boolean {
  const wanted = CATEGORY_TO_POI[cat] || cat;
  if (po.category === wanted) return true;
  if (cat === "机场") return /机场|航站楼|航空/.test(po.name || "");
  if (cat === "火车站") return /火车站|高铁站|动车站|车站/.test(po.name || "");
  return false;
}

export default function MapPoiSearch({
  city,
  source,
  selectedIds,
  onLocate,
  onResultsChange,
  zoomEnough,
}: {
  city: string;
  source: DataSource;
  selectedIds: Set<string>;
  onLocate: (term: string) => Promise<LocateFeedback>;
  /** 把当前高亮结果同步给地图渲染；取消时传空数组 */
  onResultsChange: (pois: PoiSnapshot[]) => void;
  /** 地图是否已放大到可显示高亮点的级别（低于该级别只提示、不打点） */
  zoomEnough: boolean;
}) {
  const [q, setQ] = useState("");
  const [scope, setScope] = useState(city);
  /** 必须先成功回车定位，分类按钮才可用 */
  const [located, setLocated] = useState(false);
  const [locating, setLocating] = useState(false);
  const [cat, setCat] = useState("");
  const [categoryPois, setCategoryPois] = useState<PoiSnapshot[]>([]);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  /** 分类请求序号：快速切换 / 重新定位时丢弃过期响应 */
  const catSeq = useRef(0);
  /** 当前作用域镜像：用于区分「会话回填同一城市」和「用户真的换了城市」 */
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  // 真正切换目的地城市才重置定位；会话异步回填相同城市不打断用户
  useEffect(() => {
    // 城市被清空（会话尚未回填）时保留已定位范围，不打断用户
    if (!city || normPlace(city) === normPlace(scopeRef.current)) return;
    catSeq.current += 1;
    setScope(city);
    setLocated(false);
    setCat("");
    setCategoryPois([]);
    setCategoryLoading(false);
    setQ("");
    setError("");
  }, [city]);

  useEffect(
    () => () => {
      window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  const results = useMemo(
    () => (cat ? categoryPois.filter((po) => matchCategory(cat, po)) : []),
    [cat, categoryPois],
  );

  // 结果实时驱动地图高亮
  useEffect(() => {
    onResultsChange(results);
  }, [results, onResultsChange]);

  /** 点击分类：始终按当前定位范围拉取该分类全量，避免旧结果池没有该类导致空高亮 */
  const pickCategory = (c: string) => {
    if (!located) return;
    const next = cat === c ? "" : c;
    const id = ++catSeq.current;
    setCat(next);
    setCategoryPois([]);
    setCategoryLoading(false);
    setError("");
    if (!next) return;
    if (!scope) {
      setError("请先输入地点名称并回车定位");
      return;
    }
    setCategoryLoading(true);
    // 离线快照内部把美食记为餐厅；在线关键词直接用界面展示名
    const term = source === "local" ? CATEGORY_TO_POI[next] || next : next;
    searchPois(term, scope, source)
      .then((list) => {
        if (catSeq.current === id) setCategoryPois(list);
      })
      .catch((e: any) => {
        if (catSeq.current !== id) return;
        setCategoryPois([]);
        setError(e?.message || String(e));
      })
      .finally(() => {
        if (catSeq.current === id) setCategoryLoading(false);
      });
  };

  /** 回车定位：成功后设置搜索范围并解锁分类 */
  const submitLocate = async () => {
    const term = q.trim();
    if (!term || locating) return;
    setLocating(true);
    const r = await onLocate(term);
    setLocating(false);
    window.clearTimeout(noticeTimer.current);
    setNotice({ ok: r.ok, text: r.msg });
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2600);
    if (!r.ok) return;
    catSeq.current += 1;
    if (typeof r.scope === "string" && r.scope) setScope(r.scope);
    setLocated(true);
    setCat("");
    setCategoryPois([]);
    setCategoryLoading(false);
    setError("");
    setQ("");
  };

  const tipBeforeLocate = "先输入地点名称并回车定位，再点击分类高亮";
  const tipAfterLocate = "点击分类在地图上高亮，再点一次取消";

  return (
    <div className="map-search-panel" onWheel={(e) => e.stopPropagation()}>
      <div className="msp-head">
        <div className="msp-searchbar">
          <input
            className="msp-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              void submitLocate();
            }}
            placeholder="输入地点名称，回车定位地图"
          />
        </div>
        <div className="msp-hintline">
          <span>{located ? tipAfterLocate : tipBeforeLocate}</span>
          {notice && (
            <span className={`msp-notice${notice.ok ? "" : " bad"}`}>{notice.text}</span>
          )}
          {locating || categoryLoading ? <span className="msp-notice">加载中…</span> : null}
          {error ? <span className="msp-notice bad">{error}</span> : null}
          <span className="msp-scope">范围：{scope || "全国"}</span>
        </div>
        <div className="msp-filters tag-row">
          {CATEGORY_FILTERS.map((c) => (
            <button
              key={c}
              type="button"
              disabled={!located}
              title={
                !located
                  ? "请先输入地点名称并回车定位"
                  : cat === c
                    ? `取消高亮${c}`
                    : `在地图上高亮${c}`
              }
              className={cat === c ? "tag-on" : "tag-off"}
              onClick={() => pickCategory(c)}
            >
              <span className="msp-cat-icon">{CATEGORY_ICON[c] || "📍"}</span>
              {c}
            </button>
          ))}
        </div>
      </div>
      {!cat && (
        <div className="msp-mini">
          {located
            ? `已定位：${scope || "全国"} · 已选 ${selectedIds.size} 个（点击分类高亮地图）`
            : "定位后可逐类高亮地图，点击高亮点即可加入路线"}
        </div>
      )}
      {cat && !zoomEnough && (
        <div className="msp-mini msp-zoom-tip">
          当前比例尺过小，放大地图后显示 {results.length} 个高亮点
        </div>
      )}
      {cat && zoomEnough && categoryLoading && (
        <div className="msp-mini msp-zoom-tip">正在加载{cat}地点…</div>
      )}
      {cat && zoomEnough && !categoryLoading && results.length === 0 && (
        <div className="msp-mini msp-zoom-tip">
          {source === "local"
            ? `离线模式暂无「${scope}」的${cat}数据，请切换在线模式`
            : `「${scope || "全国"}」暂无${cat}地点数据`}
        </div>
      )}
    </div>
  );
}
