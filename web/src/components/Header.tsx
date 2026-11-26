/** 途稳 · 顶部品牌栏 */
import { Button } from "@douyinfe/semi-ui";
import type { AuthUser } from "../auth";

function LogoMark() {
  // 极简指南针 / 航迹标记：寓意「稳稳的旅途」
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.9)" strokeWidth="1.6" />
      <path
        d="M15.5 8.5l-2.1 5.2-5.2 2.1 2.1-5.2 5.2-2.1z"
        fill="#fff"
        stroke="rgba(255,255,255,0.6)"
        strokeWidth="0.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="1.4" fill="#0f172a" />
    </svg>
  );
}

export default function Header({
  configuredCount,
  totalModels,
  running,
  user,
  onLogout,
}: {
  configuredCount: number;
  totalModels: number;
  running: boolean;
  user?: AuthUser;
  onLogout?: () => void;
}) {
  return (
    <header className="app-header glass fade-up">
      <div className="brand">
        <div className="brand-mark">
          <LogoMark />
        </div>
        <div>
          <div className="brand-name">途稳</div>
          <div className="brand-tag">
            <span className="dot" />
            韧性出行规划 · 为家庭稳稳抵达
          </div>
        </div>
      </div>
      <div className="header-right">
        <span className="chip">
          {running ? "● 规划中" : "● 就绪"}
        </span>
        <span className="chip">
          模型 {configuredCount}/{totalModels}
        </span>
        <span className="chip">pi Agent</span>
        {user && (
          <>
            <span className="chip">👤 {user.username}</span>
            <Button size="small" onClick={onLogout}>
              退出登录
            </Button>
          </>
        )}
      </div>
    </header>
  );
}
