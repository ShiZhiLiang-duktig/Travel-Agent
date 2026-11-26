/**
 * 途稳 · 管理端（登录后的管理员独立界面）。
 * 与用户端共用极简视觉与主题系统，但信息架构不同：
 *   总览（指标 + 系统状态） / 用户管理 / 运行记录（含单次运行详情）。
 * 不包含地图与行程规划等用户功能。
 *
 * 说明：用户端的实时 SSE 事件流属于「单次运行过程」，管理端无法实时接管；
 * 这里改为「运行记录详情」——按落库的指标展示每次规划的约束通过率、韧性、花费等。
 */
import { useCallback, useEffect, useState } from "react";
import { Table, Button, Tag, Toast, Spin } from "@douyinfe/semi-ui";
import { authHeaders, type AuthUser } from "./auth";
import TopBar from "./components/TopBar";

const BASE = "";

interface AdminUser {
  id: number;
  username: string;
  role: string;
  created_at: string;
}

interface AdminRun {
  id: number;
  created_at: string;
  city: string;
  days: number;
  mode: string;
  model: string | null;
  total_cost: number | null;
  item_count: number | null;
  constraint_pass_rate: number | null;
  hallucination_rate: number | null;
  resilience_score: number | null;
}

type AdminView = "overview" | "users" | "runs";

const NAV: { key: AdminView; label: string; icon: string }[] = [
  { key: "overview", label: "总览", icon: "📊" },
  { key: "users", label: "用户管理", icon: "👥" },
  { key: "runs", label: "运行记录", icon: "📋" },
];

const HERO: Record<AdminView, { title: string; sub: string }> = {
  overview: {
    title: "系统总览",
    sub: "关键运营指标、数据库与鉴权状态一览。",
  },
  users: {
    title: "用户管理",
    sub: "查看平台账号与角色，移除不再需要的用户。",
  },
  runs: {
    title: "运行记录",
    sub: "每次规划落库后的指标明细，点击任意一行查看完整详情。",
  },
};

function pct(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${Math.round(Number(v) * 100)}%`;
}

function fmtTime(s: string): string {
  try {
    const d = new Date(s);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return s;
  }
}

export default function AdminApp({
  user,
  onLogout,
}: {
  user: AuthUser;
  onLogout: () => void;
}) {
  const [view, setView] = useState<AdminView>("overview");

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [runs, setRuns] = useState<AdminRun[]>([]);
  const [dbReady, setDbReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [selectedRun, setSelectedRun] = useState<AdminRun | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const h = { headers: authHeaders() };
      const [uRes, rRes] = await Promise.all([
        fetch(`${BASE}/api/admin/users`, h),
        fetch(`${BASE}/api/admin/runs?limit=50`, h),
      ]);
      if (uRes.status === 401 || uRes.status === 403) {
        onLogout();
        return;
      }
      const uj = await uRes.json().catch(() => ({}));
      const rj = await rRes.json().catch(() => ({}));
      setUsers(uj.users || []);
      setRuns(rj.runs || []);
      setDbReady(!!rj.dbReady);
    } catch {
      Toast.error("加载管理数据失败");
    } finally {
      setLoading(false);
    }
  }, [onLogout]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleDelete = async (id: number, username: string) => {
    if (id === user.id) {
      Toast.warning("不能删除当前登录账号");
      return;
    }
    if (!window.confirm(`确定删除用户「${username}」吗？此操作不可撤销。`)) return;
    setDeleting(id);
    try {
      const resp = await fetch(`${BASE}/api/admin/users/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(j.error || "删除失败");
      Toast.success("已删除");
      setUsers((prev) => prev.filter((u) => u.id !== id));
    } catch (err: any) {
      Toast.error(err?.message || "删除失败");
    } finally {
      setDeleting(null);
    }
  };

  // 汇总指标
  const totalRuns = runs.length;
  const avgConstraint =
    runs.length > 0
      ? runs.reduce((s, r) => s + (r.constraint_pass_rate ?? 0), 0) / runs.length
      : 0;
  const avgResilience =
    runs.length > 0
      ? runs.reduce((s, r) => s + (r.resilience_score ?? 0), 0) / runs.length
      : 0;

  const stats = [
    { label: "注册用户", value: String(users.length) },
    { label: "规划运行次数", value: String(totalRuns) },
    { label: "平均约束通过率", value: pct(avgConstraint) },
    { label: "平均韧性得分", value: pct(avgResilience) },
  ];

  const hero = HERO[view];

  return (
    <div className="app-shell">
      <TopBar
        nav={NAV.map((n) => ({ key: n.key, label: n.label }))}
        active={view}
        onChange={(k) => setView(k as AdminView)}
        user={user}
        onLogout={onLogout}
        subtitle="管理后台"
      />

      <main className="admin-workspace">
        <div className="page-hero fade-up">
          <div className="page-eyebrow">
            <span className="page-eyebrow-dot" />
            管理后台 · 系统运营
          </div>
          <h1 className="page-title">{hero.title}</h1>
          <p className="page-sub">{hero.sub}</p>
        </div>

        {/* ---------- 总览 ---------- */}
        {view === "overview" && (
          <>
            <div className="adm-stats">
              {stats.map((s) => (
                <div key={s.label} className="glass adm-stat">
                  <div className="adm-stat-value">{s.value}</div>
                  <div className="adm-stat-label">{s.label}</div>
                </div>
              ))}
            </div>

            <div className="glass adm-panel">
              <div className="adm-panel-head">
                <h3>系统状态</h3>
                <Button size="small" onClick={() => void loadData()} loading={loading}>
                  刷新
                </Button>
              </div>
              <div className="adm-status-list">
                <div className="adm-status-row">
                  <span className={`adm-dot ${dbReady ? "ok" : "bad"}`} />
                  数据库：{dbReady ? "已连接（PostgreSQL / PgVector）" : "未连接（语义检索与记录落库不可用）"}
                </div>
                <div className="adm-status-row">
                  <span className="adm-dot ok" />
                  鉴权服务：正常（内存会话 · 7 天有效期）
                </div>
                <div className="adm-status-row">
                  <span className="adm-dot ok" />
                  当前管理员：{user.username}
                </div>
              </div>
            </div>
          </>
        )}

        {/* ---------- 用户管理 ---------- */}
        {view === "users" && (
          <div className="glass adm-panel">
            <div className="adm-panel-head">
              <h3>全部账号</h3>
              <span className="adm-count">共 {users.length} 人</span>
            </div>
            {loading ? (
              <div className="adm-loading">
                <Spin />
              </div>
            ) : (
              <Table
                dataSource={users}
                rowKey="id"
                pagination={false}
                size="small"
                columns={[
                  { title: "ID", dataIndex: "id", width: 80 },
                  { title: "用户名", dataIndex: "username" },
                  {
                    title: "角色",
                    dataIndex: "role",
                    width: 120,
                    render: (role: string) => (
                      <Tag color={role === "admin" ? "red" : "blue"} size="small">
                        {role === "admin" ? "管理员" : "普通用户"}
                      </Tag>
                    ),
                  },
                  {
                    title: "注册时间",
                    dataIndex: "created_at",
                    render: (v: string) => fmtTime(v),
                  },
                  {
                    title: "操作",
                    width: 100,
                    render: (_: any, record: AdminUser) => (
                      <Button
                        type="danger"
                        size="small"
                        disabled={record.id === user.id}
                        loading={deleting === record.id}
                        onClick={() => handleDelete(record.id, record.username)}
                      >
                        删除
                      </Button>
                    ),
                  },
                ]}
              />
            )}
          </div>
        )}

        {/* ---------- 运行记录（列表 + 详情） ---------- */}
        {view === "runs" && (
          <div className="adm-runs">
            <div className="glass adm-panel">
              <div className="adm-panel-head">
                <h3>规划运行记录</h3>
                <span className="adm-count">最近 {runs.length} 条</span>
              </div>
              {loading ? (
                <div className="adm-loading">
                  <Spin />
                </div>
              ) : (
                <Table
                  dataSource={runs}
                  rowKey="id"
                  pagination={{ pageSize: 8 }}
                  size="small"
                  rowClassName={(record: AdminRun) =>
                    record.id === selectedRun?.id ? "adm-row-active" : ""
                  }
                  onRow={(record: AdminRun | undefined) => ({
                    onClick: () => record && setSelectedRun(record),
                    style: { cursor: "pointer" },
                  })}
                  columns={[
                    { title: "ID", dataIndex: "id", width: 64 },
                    {
                      title: "时间",
                      dataIndex: "created_at",
                      render: (v: string) => fmtTime(v),
                      width: 140,
                    },
                    { title: "城市", dataIndex: "city", width: 80 },
                    { title: "天数", dataIndex: "days", width: 64 },
                    { title: "模式", dataIndex: "mode", width: 100 },
                    {
                      title: "约束通过",
                      dataIndex: "constraint_pass_rate",
                      render: (v: number | null) => pct(v),
                      width: 92,
                    },
                    {
                      title: "韧性",
                      dataIndex: "resilience_score",
                      render: (v: number | null) => pct(v),
                      width: 72,
                    },
                    {
                      title: "花费",
                      dataIndex: "total_cost",
                      render: (v: number | null) => (v != null ? `¥${v}` : "—"),
                      width: 76,
                    },
                  ]}
                />
              )}
            </div>

            <div className="glass adm-detail">
              {selectedRun ? (
                <>
                  <div className="adm-detail-head">
                    <div className="adm-detail-title">运行 #{selectedRun.id}</div>
                    <Tag size="small">{selectedRun.mode}</Tag>
                  </div>
                  <div className="adm-detail-metrics">
                    <div>
                      <b>{pct(selectedRun.constraint_pass_rate)}</b>
                      <span>约束通过率</span>
                    </div>
                    <div>
                      <b>{pct(selectedRun.resilience_score)}</b>
                      <span>韧性得分</span>
                    </div>
                  </div>
                  <div className="adm-kv">
                    <div>
                      <span>时间</span>
                      <b>{fmtTime(selectedRun.created_at)}</b>
                    </div>
                    <div>
                      <span>城市 / 天数</span>
                      <b>
                        {selectedRun.city} · {selectedRun.days} 天
                      </b>
                    </div>
                    <div>
                      <span>模型</span>
                      <b>{selectedRun.model || "—"}</b>
                    </div>
                    <div>
                      <span>行程条目</span>
                      <b>{selectedRun.item_count ?? "—"}</b>
                    </div>
                    <div>
                      <span>总花费</span>
                      <b>{selectedRun.total_cost != null ? `¥${selectedRun.total_cost}` : "—"}</b>
                    </div>
                    <div>
                      <span>幻觉率</span>
                      <b>{pct(selectedRun.hallucination_rate)}</b>
                    </div>
                  </div>
                </>
              ) : (
                <div className="adm-detail-empty">
                  <div style={{ fontSize: 28, opacity: 0.6 }}>📋</div>
                  <div>点击左侧任意一条记录查看详情</div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
