/**
 * 途稳 · 顶层鉴权路由。
 *
 * 未登录 → 登录页；登录后按角色进入完全独立的两套界面：
 *   - user  → UserApp（旅行规划：地图 / 偏好 / 行程）
 *   - admin → AdminApp（管理后台：用户管理 / 运行记录 / 系统状态）
 *
 * 刷新页面时用本地 token 调 /api/auth/me 校验；失效则清除并回到登录页。
 * 两套界面是各自独立的组件树与信息架构（经验：不要在同一 DOM 里隐藏切换）。
 */
import { useEffect, useState } from "react";
import { Spin } from "@douyinfe/semi-ui";
import LoginPage from "./components/LoginPage";
import SharedPage from "./components/SharedPage";
import UserApp from "./UserApp";
import AdminApp from "./AdminApp";
import { fetchMe, logout, getStoredUser, type AuthUser } from "./auth";
import { initTheme } from "./theme";

/** 从 hash 中解析只读分享 slug（#/s/<slug>），不匹配返回 null */
function readShareSlug(): string | null {
  const m = /^#\/s\/([A-Za-z0-9_-]{4,32})$/.exec(window.location.hash);
  return m ? m[1] : null;
}

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  // 分享页优先于登录流程：链接对未登录访客也必须可看
  const [shareSlug, setShareSlug] = useState<string | null>(() => readShareSlug());

  useEffect(() => {
    const onHash = () => setShareSlug(readShareSlug());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // 启动即应用已保存的主题（登录页与管理端同样生效）
  useEffect(() => {
    initTheme();
  }, []);

  // 启动：校验本地 token 有效性
  useEffect(() => {
    let alive = true;
    const stored = getStoredUser();
    if (!stored) {
      setLoading(false);
      return;
    }
    fetchMe()
      .then((u) => {
        if (!alive) return;
        setUser(u);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const handleLogout = async () => {
    await logout();
    setUser(null);
  };

  if (shareSlug) {
    return <SharedPage slug={shareSlug} />;
  }

  if (loading) {
    return (
      <div className="auth-loading">
        <Spin size="large" />
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLogin={setUser} />;
  }

  // 按角色路由到各自独立界面
  if (user.role === "admin") {
    return <AdminApp user={user} onLogout={handleLogout} />;
  }
  return <UserApp user={user} onLogout={handleLogout} />;
}
