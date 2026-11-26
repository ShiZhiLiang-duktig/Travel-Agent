/** 旅行偏好面板：预算 / 人群 / 节奏 / 必去 / 避开 / 开关 + 补充描述。
 *  偏好变化会在 App 里自动拼入 requirement（喂给 AI），不改动后端协议。 */
import { Button, InputNumber, Select, Switch, TextArea } from "@douyinfe/semi-ui";
import { IconPlay, IconRefresh } from "@douyinfe/semi-icons";
import type { TravelPreferences, PoiSnapshot, AmapPoiBrief } from "../api";
import {
  GROUP_OPTIONS,
  PACE_OPTIONS,
  AVOID_OPTIONS,
} from "../meta";

interface Props {
  prefs: TravelPreferences;
  setPrefs: (p: TravelPreferences) => void;
  pois: PoiSnapshot[];
  /** 必去景点的在线搜索候选（高德），为空时回退到本地 POI 名称 */
  poiOptions?: string[];
  /** 候选详情（缩略图 / 评分 / 营业时间 / 地址） */
  poiBriefs?: AmapPoiBrief[];
  onSearchPoi?: (q: string) => void;
  extra: string;
  setExtra: (v: string) => void;
  /** 开始规划（按钮放在偏好卡片底部） */
  onRun?: () => void;
  /** 清空全部输入与结果 */
  onReset?: () => void;
  running?: boolean;
  /** 城市与出行日期是否齐备 */
  canRun?: boolean;
}

export default function PreferencePanel(p: Props) {
  const toggle = (key: "group" | "avoid", val: string) => {
    const arr = p.prefs[key];
    p.setPrefs({
      ...p.prefs,
      [key]: arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val],
    });
  };

  /** 点击候选卡片：加入 / 移出必去景点 */
  const toggleMust = (name: string) => {
    const arr = p.prefs.must_visit;
    p.setPrefs({
      ...p.prefs,
      must_visit: arr.includes(name) ? arr.filter((x) => x !== name) : [...arr, name],
    });
  };

  return (
    <section className="pref-panel glass fade-up">
      <div className="section-title">
        <span className="accent-bar" />
        <h3>旅行偏好</h3>
        <span className="meta">
          <span className="pill">偏好自动写入 AI 需求</span>
        </span>
      </div>

      <div className="pref-grid">
        <div className="pref-field">
          <div className="field-label">总预算（元）</div>
          <InputNumber
            value={p.prefs.budget}
            min={0}
            placeholder="不限"
            onChange={(v) => p.setPrefs({ ...p.prefs, budget: v == null ? undefined : Number(v) })}
            style={{ width: "100%" }}
          />
        </div>

        <div className="pref-field">
          <div className="field-label">行程节奏</div>
          <div className="tag-row">
            {PACE_OPTIONS.map((o) => (
              <button
                key={o.value}
                className={p.prefs.pace === o.value ? "tag-on" : "tag-off"}
                onClick={() => p.setPrefs({ ...p.prefs, pace: o.value })}
                type="button"
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="pref-field">
          <div className="field-label">出行人群</div>
          <div className="tag-row">
            {GROUP_OPTIONS.map((g) => (
              <button
                key={g}
                className={p.prefs.group.includes(g) ? "tag-on" : "tag-off"}
                onClick={() => toggle("group", g)}
                type="button"
              >
                {g}
              </button>
            ))}
          </div>
        </div>

        <div className="pref-field col-span-2">
          <div className="field-label">必去景点</div>
          <Select
            multiple
            filter={() => true}
            remote
            value={p.prefs.must_visit}
            onChange={(v) => p.setPrefs({ ...p.prefs, must_visit: (v as string[]) || [] })}
            onSearch={(q) => p.onSearchPoi?.(q)}
            style={{ width: "100%" }}
            placeholder="输入景点名搜索并选择（可多选）"
            optionList={Array.from(
              new Set([
                ...(p.poiOptions && p.poiOptions.length
                  ? p.poiOptions
                  : p.pois.map((po) => po.name)),
                // 已选但尚未出现在候选表里的名称（多为刷新后恢复的草稿）必须保留，
                // 否则 remote 多选会把它们当无效值丢掉，表现为「必去景点被清空」
                ...p.prefs.must_visit,
              ]),
            ).map((n) => ({ label: n, value: n }))}
          />
          {/* 候选卡片：城市 POI 兜底 + 搜索结果，点击即可加入必去 */}
          {p.poiBriefs && p.poiBriefs.length > 0 ? (
            <div className="poi-brief-grid">
              {p.poiBriefs.map((b) => {
                const on = p.prefs.must_visit.includes(b.name);
                return (
                  <button
                    type="button"
                    key={b.name}
                    className={`poi-brief-card${on ? " on" : ""}`}
                    onClick={() => toggleMust(b.name)}
                    title={on ? "点击移出必去景点" : "点击加入必去景点"}
                  >
                    {b.photo ? (
                      <img
                        className="poi-brief-thumb"
                        src={b.photo}
                        alt={b.name}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <span className="poi-brief-thumb poi-brief-ph">📍</span>
                    )}
                    <span className="poi-brief-body">
                      <span className="poi-brief-name">{b.name}</span>
                      <span className="poi-brief-meta">
                        {b.rating && <span className="poi-brief-rating">⭐ {b.rating}</span>}
                        {b.cost && <span>人均 ¥{b.cost}</span>}
                        {b.openTime && <span>🕘 {b.openTime}</span>}
                      </span>
                      {b.address && <span className="poi-brief-addr">{b.address}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="poi-brief-empty">
              选择目的地城市后这里会推荐 9 个热门景点；离线模式内置苏州 / 杭州 / 南京，
              在线模式会自动拉取该城市全部景点。
            </p>
          )}
        </div>

        <div className="pref-field col-span-2">
          <div className="field-label">尽量避开</div>
          <div className="tag-row">
            {AVOID_OPTIONS.map((a) => (
              <button
                key={a}
                className={p.prefs.avoid.includes(a) ? "tag-on" : "tag-off"}
                onClick={() => toggle("avoid", a)}
                type="button"
              >
                {a}
              </button>
            ))}
          </div>
        </div>

        <div className="pref-field switch-field">
          <Switch
            checked={p.prefs.afternoon_indoor}
            onChange={(c) => p.setPrefs({ ...p.prefs, afternoon_indoor: c })}
          />
          <span>下午安排室内活动</span>
        </div>
        <div className="pref-field switch-field">
          <Switch
            checked={p.prefs.must_have_lunch}
            onChange={(c) => p.setPrefs({ ...p.prefs, must_have_lunch: c })}
          />
          <span>午休不能省</span>
        </div>

        <div className="pref-field col-span-2">
          <div className="field-label">补充描述</div>
          <TextArea
            value={p.extra}
            onChange={p.setExtra}
            rows={2}
            placeholder="例如：第一天想先去博物馆，晚餐想吃本帮菜，孩子想看夜景……"
          />
        </div>
      </div>

      {/* 开始规划 / 清空：收进偏好卡片底部，不再单独占一条横幅 */}
      {p.onRun && (
        <div className="pref-actions">
          <Button
            className="btn-run"
            theme="solid"
            icon={<IconPlay />}
            loading={p.running}
            onClick={p.onRun}
            disabled={!p.canRun}
          >
            {p.running ? "规划中…" : "开始规划"}
          </Button>
          <Button
            className="btn-ghost"
            icon={<IconRefresh />}
            onClick={p.onReset}
            disabled={p.running}
          >
            清空
          </Button>
        </div>
      )}
    </section>
  );
}
