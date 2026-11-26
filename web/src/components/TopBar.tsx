/**
 * 途稳 · 顶部通栏（用户端 / 管理端共用）。
 * 品牌 + 主导航 + 状态 + 主题色 + 用户信息，参考携程式「功能与账号信息置于顶端」。
 */
import { useState } from "react";
import { THEMES, applyTheme, getStoredTheme, type ThemeKey } from "../theme";
import type { AuthUser } from "../auth";
import type { DataSource } from "../api";

export interface TopNavItem {
  key: string;
  label: string;
}

export interface TopChip {
  text: string;
  tone?: "ok" | "busy";
}

export default function TopBar({
  nav,
  active,
  onChange,
  user,
  onLogout,
  subtitle = "AI 行程助手",
  chips = [],
  dataSource,
  onDataSourceChange,
  profileCity,
  onOpenProfile,
}: {
  nav: TopNavItem[];
  active: string;
  onChange: (key: string) => void;
  user: AuthUser;
  onLogout: () => void;
  subtitle?: string;
  chips?: TopChip[];
  /** 数据源切换（仅用户端传）：local=离线内置数据，online=在线高德全量数据 */
  dataSource?: DataSource;
  onDataSourceChange?: (s: DataSource) => void;
  /** 所属城市（个人信息里的出发城市） */
  profileCity?: string;
  /** 打开个人信息设置 */
  onOpenProfile?: () => void;
}) {
  const [theme, setTheme] = useState<ThemeKey>(getStoredTheme);

  const pick = (k: ThemeKey) => {
    setTheme(k);
    applyTheme(k);
  };

  return (
    <header className="topbar">
      <div className="tb-brand">
        <div className="tb-logo">🧭</div>
        <span className="tb-name">途稳</span>
        <span className="tb-sub">{subtitle}</span>
      </div>

      <nav className="tb-nav">
        {nav.map((n) => (
          <button
            key={n.key}
            type="button"
            className={`tb-nav-item ${active === n.key ? "active" : ""}`}
            onClick={() => onChange(n.key)}
          >
            {n.label}
          </button>
        ))}
      </nav>

      <div className="tb-right">
        {onDataSourceChange && (
          <div className="tb-mode" role="group" aria-label="数据源切换">
            {(["local", "online"] as DataSource[]).map((s) => (
              <button
                key={s}
                type="button"
                className={`tb-mode-item ${dataSource === s ? "on" : ""}`}
                title={s === "local" ? "离线模式：使用内置数据，不联网" : "在线模式：通过高德获取全量城市与 POI"}
                onClick={() => onDataSourceChange(s)}
              >
                {s === "local" ? "离线模式" : "在线模式"}
              </button>
            ))}
          </div>
        )}

        {chips.map((c) => (
          <span key={c.text} className={`tb-chip ${c.tone || ""}`}>
            {c.text}
          </span>
        ))}

        <div className="tb-themes">
          {THEMES.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`tb-swatch ${theme === t.key ? "on" : ""}`}
              style={{ background: t.swatch }}
              title={`${t.name} · ${t.desc}`}
              aria-label={t.name}
              onClick={() => pick(t.key)}
            />
          ))}
        </div>

        <button
          type="button"
          className="tb-user tb-user-btn"
          onClick={onOpenProfile}
          title="个人信息设置"
        >
          👤 {user.username}
          {profileCity && <span className="tb-user-city">📍 {profileCity}</span>}
        </button>
        <button type="button" className="tb-logout" onClick={onLogout}>
          退出
        </button>
      </div>
    </header>
  );
}
