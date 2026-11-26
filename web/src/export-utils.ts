/**
 * 行程导出工具（零依赖）：手写 iCalendar 2.0，
 * 导入手机 / 电脑日历后即可按天查看与提醒。
 */
import type { ItineraryView } from "./api";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 日期字符串（YYYY-MM-DD）加 n 天，返回同一个格式 */
function addDaysStr(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时区的今天（YYYY-MM-DD） */
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "HH:MM" → 当天第几分钟，解析失败返回 fallback */
function toMinutes(hhmm: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || "").trim());
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 当天分钟数 → "YYYYMMDDTHHMMSS"（本地浮动时间，不写 Z，避免时区偏移） */
function icsDateTime(dateStr: string, minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const mi = minutes % 60;
  return `${dateStr.replace(/-/g, "")}T${pad2(h)}${pad2(mi)}00`;
}

/** iCalendar TEXT 转义：反斜杠、分号、逗号、换行 */
function icsEscape(s: string): string {
  return (s || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** 只保留正选行程项（排除备用项），并按天 + 开始时间排序 */
function activeItems(itinerary: ItineraryView) {
  return itinerary.items
    .filter((i) => !i.is_backup)
    .slice()
    .sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
}

/**
 * 导出 ICS 日历文件。
 * @param startDate 出行首日 YYYY-MM-DD；为空时用今天
 * @param tripName 日历事件标题前缀，如「途稳 · 苏州 3 日」
 */
export function exportItineraryIcs(
  itinerary: ItineraryView,
  startDate: string,
  tripName = "途稳行程",
): void {
  const base = startDate || todayStr();
  const items = activeItems(itinerary);
  if (!items.length) return;

  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(
    now.getUTCDate(),
  )}T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//TuWen Travel//Itinerary//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(tripName)}`,
  ];

  items.forEach((it, idx) => {
    const date = addDaysStr(base, Math.max(0, it.day - 1));
    const startMin = toMinutes(it.start, 9 * 60);
    const endMin = Math.max(startMin + 30, toMinutes(it.end, startMin + 90));
    const desc = [
      `城市：${it.city || "-"}`,
      `步行 ${it.walking_min ?? 0} 分钟 · 台阶 ${it.stairs ?? 0}`,
      `花费 ¥${it.cost ?? 0}`,
      `来源：${it.source || "-"}`,
    ].join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:tuwen-${date.replace(/-/g, "")}-${idx}@travel-agent-pi`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsDateTime(date, startMin)}`,
      `DTEND:${icsDateTime(date, endMin)}`,
      `SUMMARY:${icsEscape(`${tripName}｜D${it.day} ${it.poi}`)}`,
      `LOCATION:${icsEscape(it.city || "")}`,
      `DESCRIPTION:${icsEscape(desc)}`,
      "END:VEVENT",
    );
  });
  lines.push("END:VCALENDAR");

  const blob = new Blob([lines.join("\r\n")], {
    type: "text/calendar;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${tripName.replace(/[\\/:*?"<>|]/g, "_")}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
