/**
 * 公开只读行程页（#/s/<slug>）：无需登录，链接可直接发给任何人。
 * 只渲染行程快照，不暴露偏好、账号等隐私信息。
 */
import { useEffect, useState } from "react";
import { fetchShare, type SharedTrip } from "../api";
import ItineraryTimeline from "./ItineraryTimeline";

export default function SharedPage({ slug }: { slug: string }) {
  const [state, setState] = useState<{
    loading: boolean;
    error?: string;
    data?: SharedTrip;
  }>({ loading: true });

  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    fetchShare(slug)
      .then((data) => {
        if (alive) setState({ loading: false, data });
      })
      .catch((err) => {
        if (alive) setState({ loading: false, error: err?.message || "加载分享失败" });
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  return (
    <div className="shared-page">
      <header className="shared-head">
        <div className="shared-brand">
          <span className="shared-logo">途</span>
          <div>
            <div className="shared-title">{state.data?.title || "途稳 · 共享行程"}</div>
            <div className="shared-sub">
              只读分享 · 由途稳生成
              {state.data?.created_at ? ` · ${state.data.created_at.slice(0, 10)}` : ""}
            </div>
          </div>
        </div>
        <a className="btn-ghost shared-home" href="#/">
          我也要规划
        </a>
      </header>

      <main className="shared-body">
        {state.loading && <div className="shared-tip">正在加载行程…</div>}
        {state.error && (
          <div className="banner-err">
            <span>⚠️</span>
            <span>{state.error}</span>
          </div>
        )}
        {state.data && (
          <>
            <div className="shared-meta">
              <span className="pill blue">{state.data.city || "行程"}</span>
              <span className="pill">{state.data.days} 天</span>
              <span className="pill green">总花费 ¥{state.data.itinerary.total_cost}</span>
            </div>
            <ItineraryTimeline title="每日安排" itinerary={state.data.itinerary} />
          </>
        )}
      </main>
    </div>
  );
}
