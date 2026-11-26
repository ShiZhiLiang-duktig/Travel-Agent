/** 途稳 · 左侧固定导航栏（参考极简信息架构：品牌 / 规划导航 / 当前行程 / 主题色 / 账号） */
import { useState } from "react";
import { THEMES, applyTheme, getStoredTheme, type ThemeKey } from "../theme";
import type { AuthUser } from "../auth";

type View = "ai" | "manual";

function IconCompass() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M15.5 8.5l-2.1 5.2-5.2 2.1 2.1-5.2 5.2-2.1z"
        fill="currentColor"
        opacity="0.85"
      />
    </svg>
  );
}

function IconSpark() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3v3M12 18v3M4.2 7.2l2.1 2.1M17.7 14.7l2.1 2.1M3 12h3M18 12h3M4.2 16.8l2.1-2.1M17.7 9.3l2.1-2.1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function IconRoute() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="6" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="18" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M8.4 18H13a3 3 0 0 0 0-6h-2a3 3 0 0 1 0-6h4.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function Sidebar({
  view,
  setView,
  city,
  days,
  running,
  configuredCount,
  totalModels,
  user,
  onLogout,
}: {
  view: View;
  setView: (v: View) => void;
  city: string;
  days: number;
  running: boolean;
  configuredCount: number;
  totalModels: number;
  user: AuthUser;
  onLogout: () => void;
}) {
  const [theme, setTheme] = useState<ThemeKey>(getStoredTheme);

  const pickTheme = (k: ThemeKey) => {
    setTheme(k);
    applyTheme(k);
  };

  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <div className="sb-logo">
          <IconCompass />
        </div>
        <div>
          <div className="sb-name">途稳</div>
          <div className="sb-tag">韧性出行规划</div>
        </div>
      </div>

      <div className="sb-section">规划</div>
      <nav className="sb-nav">
        <button
          type="button"
          className={`sb-item ${view === "ai" ? "active" : ""}`}
          onClick={() => setView("ai")}
        >
          <IconSpark />
          <span>AI 规划</span>
        </button>
        <button
          type="button"
          className={`sb-item ${view === "manual" ? "active" : ""}`}
          onClick={() => setView("manual")}
        >
          <IconRoute />
          <span>手动路线</span>
        </button>
      </nav>

      <div className="sb-section">当前行程</div>
      <div className="sb-trip">
        <div className="sb-trip-row">
          <span>城市</span>
          <b>{city}</b>
        </div>
        <div className="sb-trip-row">
          <span>天数</span>
          <b>{days} 天</b>
        </div>
        <div className="sb-trip-row">
          <span>状态</span>
          <b className={running ? "sb-running" : ""}>{running ? "规划中" : "就绪"}</b>
        </div>
        <div className="sb-trip-row">
          <span>模型</span>
          <b>
            {configuredCount}/{totalModels}
          </b>
        </div>
      </div>

      <div className="sb-spacer" />

      <div className="sb-section">主题色</div>
      <div className="sb-themes">
        {THEMES.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`sb-swatch ${theme === t.key ? "on" : ""}`}
            style={{ background: t.swatch }}
            title={`${t.name} · ${t.desc}`}
            aria-label={t.name}
            onClick={() => pickTheme(t.key)}
          />
        ))}
      </div>

      <div className="sb-user">
        <span className="sb-user-name">👤 {user.username}</span>
        <button type="button" className="sb-logout" onClick={onLogout}>
          退出
        </button>
      </div>
    </aside>
  );
}
