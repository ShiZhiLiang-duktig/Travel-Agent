/**
 * 行程导出操作条：一个「导出日历」+ 一个「分享链接」。
 * AI 生成行程与手动路线行程共用，放在时间线下方。
 */
import { useState } from "react";
import type { ItineraryView } from "../api";
import { createShare } from "../api";
import { exportItineraryIcs } from "../export-utils";

interface Props {
  itinerary: ItineraryView;
  /** 出行首日 YYYY-MM-DD；为空时导出工具回落到今天 */
  startDate: string;
  /** 城市名，用作日历标题 */
  city: string;
}

export default function ExportBar({ itinerary, startDate, city }: Props) {
  const [hint, setHint] = useState("");
  /** 生成的只读分享链接（生成后展示可复制的输入框） */
  const [shareUrl, setShareUrl] = useState("");
  const [sharing, setSharing] = useState(false);
  const tripName = `${city && city !== "未选择城市" ? `${city} · ` : ""}途稳行程`;

  const handleShare = async () => {
    setSharing(true);
    setHint("");
    try {
      const { slug } = await createShare({
        itinerary,
        city,
        days: itinerary.days,
        startDate,
        title: tripName,
      });
      const url = `${location.origin}${location.pathname}#/s/${slug}`;
      setShareUrl(url);
      try {
        await navigator.clipboard.writeText(url);
        setHint("分享链接已复制，任何人无需登录即可查看");
      } catch {
        setHint("分享链接已生成，请手动复制下方地址");
      }
    } catch (err: any) {
      setHint(err?.message || "分享失败，请稍后重试");
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="export-bar fade-up">
      <button
        type="button"
        className="btn-ghost export-btn"
        onClick={() => {
          exportItineraryIcs(itinerary, startDate, tripName);
          setHint("已导出行程日历（.ics），可导入手机 / 电脑日历");
        }}
      >
        📅 导出日历
      </button>
      <button
        type="button"
        className="btn-ghost export-btn"
        onClick={handleShare}
        disabled={sharing}
      >
        {sharing ? "生成中…" : "🔗 分享链接"}
      </button>
      {hint && <span className="export-hint">{hint}</span>}
      {shareUrl && (
        <input
          className="export-share-input"
          readOnly
          value={shareUrl}
          onFocus={(e) => e.currentTarget.select()}
          title="点击可全选复制"
        />
      )}
    </div>
  );
}
