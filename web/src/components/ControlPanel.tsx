/** 行程表单：出发城市（在线搜索）+ 目的地城市（可多选跨城）+ 出发 / 结束日期 + 动态天数 */
import { Select, DatePicker } from "@douyinfe/semi-ui";

interface Props {
  cities: string[];
  setCities: (v: string[]) => void;
  cityOptions: string[];
  onSearchCity: (q: string) => void;
  startDate: string;
  setStartDate: (v: string) => void;
  endDate: string;
  setEndDate: (v: string) => void;
  days: number;
  /** 手动路线模式：目的地城市改为地图上直接选点，隐藏城市选择 */
  showCities?: boolean;
}

/** 本地时区格式化（YYYY-MM-DD） */
function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 日期字符串加 n 天 */
function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return fmt(d);
}

export default function ControlPanel(p: Props) {
  const today = fmt(new Date());
  return (
    <section className="control-panel glass fade-up">
      <div className="control-grid">
        {p.showCities !== false && (
          <div>
            <div className="field-label">目的地城市（可多选，支持跨城）</div>
            <Select
              multiple
              filter={() => true}
              remote
              value={p.cities}
              onChange={(v) => p.setCities(((v as string[]) || []).slice(0, 5))}
              onSearch={(q) => p.onSearchCity(q)}
              style={{ width: "100%" }}
              placeholder="输入城市名搜索，最多 5 个"
              optionList={p.cityOptions.map((c) => ({ label: c, value: c }))}
              maxTagCount={5}
            />
          </div>
        )}
        <div>
          <div className="field-label">出发日期</div>
          <DatePicker
            value={p.startDate ? new Date(`${p.startDate}T00:00:00`) : undefined}
            disabledDate={(d?: Date) => (d ? fmt(d) < today : false)}
            onChange={(_, s) => {
              if (s) p.setStartDate(String(s));
            }}
            style={{ width: "100%" }}
            placeholder="选择出发日期"
          />
        </div>
        <div>
          <div className="field-label">结束日期</div>
          <DatePicker
            value={p.endDate ? new Date(`${p.endDate}T00:00:00`) : undefined}
            disabled={!p.startDate}
            disabledDate={(d?: Date) => {
              if (!d) return false;
              const s = fmt(d);
              // 与后端规划上限保持一致：最长 7 天（startDate + 6）
              return s < p.startDate || s > addDays(p.startDate, 6);
            }}
            onChange={(_, s) => {
              if (s) p.setEndDate(String(s));
            }}
            style={{ width: "100%" }}
            placeholder="选择结束日期"
          />
        </div>
      </div>

      {p.startDate && p.endDate ? (
        <div className="trip-duration">
          共 <b>{p.days}</b> 天
          <span className="trip-duration-sub">
            {p.startDate} 至 {p.endDate}
          </span>
        </div>
      ) : (
        <div className="trip-duration trip-duration-idle">请先选择出发与结束日期</div>
      )}
    </section>
  );
}
