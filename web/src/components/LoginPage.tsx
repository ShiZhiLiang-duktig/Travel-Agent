/**
 * 登录页 —— 未登录时的唯一入口。
 * 登录/注册共用一个卡片（Tab 切换），成功后由父组件按角色路由到各自界面。
 */
import { useState } from "react";
import { Input, Button, Tabs, Toast } from "@douyinfe/semi-ui";
import { IconUser, IconLock } from "@douyinfe/semi-icons";
import { login, register, setSession, type AuthUser } from "../auth";

function LogoMark() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden>
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

export default function LoginPage({ onLogin }: { onLogin: (user: AuthUser) => void }) {
  const [tab, setTab] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [regOk, setRegOk] = useState(false);

  const submit = async () => {
    setError(null);
    if (!username.trim() || !password) {
      setError("请输入用户名和密码");
      return;
    }
    setLoading(true);
    try {
      if (tab === "login") {
        const { token, user } = await login(username.trim(), password);
        setSession(token, user);
        onLogin(user);
      } else {
        await register(username.trim(), password);
        setRegOk(true);
        Toast.success("注册成功，请登录");
        setTab("login");
        setPassword("");
      }
    } catch (err: any) {
      setError(err?.message || "操作失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card glass fade-up">
        <div className="login-brand">
          <div className="login-logo">
            <LogoMark />
          </div>
          <div className="login-title">途稳</div>
          <div className="login-sub">登录后开启你的专属行程规划</div>
        </div>

        <Tabs
          type="line"
          activeKey={tab}
          onChange={(k) => {
            setTab(k as "login" | "register");
            setError(null);
            setRegOk(false);
          }}
          style={{ marginBottom: 16 }}
        >
          <Tabs.TabPane tab="登录" itemKey="login" />
          <Tabs.TabPane tab="注册" itemKey="register" />
        </Tabs>

        <div className="login-field">
          <Input
            value={username}
            onChange={(v) => setUsername(String(v))}
            prefix={<IconUser />}
            placeholder="用户名"
            size="large"
            onEnterPress={submit}
          />
        </div>
        <div className="login-field">
          <Input
            value={password}
            onChange={(v) => setPassword(String(v))}
            prefix={<IconLock />}
            placeholder="密码"
            type="password"
            size="large"
            mode="password"
            onEnterPress={submit}
          />
        </div>

        {error && <div className="login-err">{error}</div>}
        {regOk && tab === "login" && (
          <div className="login-ok">注册成功，请使用新账号登录</div>
        )}

        <Button
          theme="solid"
          type="primary"
          size="large"
          block
          loading={loading}
          onClick={submit}
          style={{ marginTop: 8 }}
        >
          {tab === "login" ? "登 录" : "注 册"}
        </Button>

        <div className="login-hint">
          <div className="hint-title">演示账号（可直接登录体验）</div>
          <div className="hint-row">
            <span className="hint-tag admin">管理员</span>
            <code>admin</code> / <code>admin123</code>
          </div>
          <div className="hint-row">
            <span className="hint-tag user">普通用户</span>
            <code>user</code> / <code>user123</code>
          </div>
        </div>
      </div>
      <div className="login-foot">途稳 · 韧性出行规划 Agent</div>
    </div>
  );
}
