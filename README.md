# 途稳 · travel-agent-pi

> **途稳（TuWen）** —— 基于 [pi 框架](https://github.com/MarioZechner/pi) 构建的韧性旅行规划 Agent（TypeScript 版）。
> 取名「途稳」，寓意「行稳致远」：为带老人小孩的家庭生成**约束可验证**、**抗扰动**的行程，并用地图把轨迹可视化呈现。
> 从自然语言需求出发，具备**抗扰动重规划**、**权限分级**、**因果归因**、**全链路 Trace** 与**地图轨迹可视化**能力。

本项目用 TypeScript 从零实现：核心引擎（排程 / 校验 / 韧性压测 / 重规划）全部为原生 TS 代码，外层用 `pi-agent-core` 做单 Agent + 多工具编排。为保证扰动采样的可复现性，`src/core/rng.ts` 自实现 MT19937 并与 CPython `random.Random` 字节级对齐，同 seed 下扰动序列与韧性分完全可复现、可审计。

## ✨ 核心特性

- **约束可验证行程生成** — 贪心排程器处理预算 / 台阶 / 步行强度 / 时间窗 / 下午室内 / 午休 / 必去景点等 8 类硬约束，8 类断言全部可溯源到 POI 快照。
- **抗扰动重规划** — 注入降雨、闭馆、堵车、老人疲惫、排队等扰动后，最小改动补位：只移除受影响项、优先把备用项补回原来的天，其余行程保持不变，改动节点数可量化。
- **权限分级钩子** — 工具按 `read` / `reversible_write` / `external_action` 分级；外部动作（如 `book_ticket` 订票）未获人工批准一律拦截，安全默认。
- **因果归因** — 把韧性扣分分解到「扰动 → POI → 约束」，定位真正的脆弱点，而非只给一个总分。
- **DSL 约束描述** — 可用声明式 DSL 表达旅行者偏好，`dsl_to_constraints` 转为引擎约束，`run_dsl_assertions` 做断言校验。
- **全链路 Trace** — 每次运行产出 JSONL 事件流 + 指标聚合到 `traces/metrics_index.json`，可回放、可审计。
- **地图轨迹可视化** — 生成的行程自动在地图上按天着色打点连线；接入高德地图后显示真实瓦片 + 步行路线规划，未配置 Key 时降级为自绘 SVG 示意图。
- **在线 / 离线双数据源** — 在线模式经后端代理拉取高德全量 POI；离线模式用内置快照（苏州 / 杭州 / 南京）与**全国 17 城交通枢纽表**（机场 / 火车站离线也能高亮），未覆盖的城市明确返回「不可用」而绝不拿别的城市数据冒充。
- **多用户账号与权限** — 注册 / 登录 / 会话 / 角色守卫（`user` / `admin`）；密码 scrypt 加盐哈希，个人信息（昵称 / 出发城市 / 简介）设置一次即持久保存、用户间隔离。
- **草稿恢复与偏好重置** — 城市、日期、当前视图和手动选点自动写入本地草稿，刷新后恢复；预算 / 节奏 / 人群 / 必去 / 避开 / 日程开关 / 补充描述按当前产品行为在刷新后回到默认值，避免上一次偏好误影响新行程。
- **只读分享** — 行程可生成公开短链 `/s/:slug`，未登录访客可查看；分享内容同样落盘持久化，重启不失效。
- **城际交通 / 天气 / 航班** — 出发地到目的地的飞机 / 高铁 / 自驾推荐（可接 12306 实时车次）、出行天气预报（高德 → Open-Meteo 降级）、航班数据源自检。
- **零 Key 可离线演示** — 无 `OPENAI_API_KEY` 时自动走 faux provider 预设脚本，保证面试现场一定能跑；有 Key 时切真实 LLM 自主调度工具。
- **零 Docker 开箱即用** — PostgreSQL 没启动时服务自动启用**本地文件后端**：语义检索用 JS 余弦相似度、运行记录与用户信息写本地 JSON，不再有「数据库不可用」的报错。

## 🛠 技术栈

| 类别 | 选型 |
|---|---|
| 语言 | TypeScript 7（`strict`，`module: NodeNext`，ESM） |
| Agent 框架 | `@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`（v0.73） |
| 大模型 | 多模型可插拔（pi-ai 直连兼容端点）：国内 DeepSeek / 智谱 GLM / Kimi / 通义 / 豆包 / 文心一言 / 阶跃星辰，国际 OpenAI / Anthropic |
| 前端 | React 18 + [Semi Design](https://semi.design/) + [Rsbuild](https://rsbuild.dev/)（Rspack 构建） |
| Web 服务 | [Hono](https://hono.dev/) + Node 适配器，SSE 流式推送 pi Agent Runtime 生命周期事件 |
| 向量 / 语义检索 | **PostgreSQL + PgVector**（可选，HNSW 索引）；PG 不可用 → **本地文件后端**（`.data/local-db.json`，纯 JS 余弦相似度，零新增依赖） |
| Embedding | 智谱 `embedding-3`（可选）/ 本地确定性哈希（默认，零 Key 零依赖），统一 512 维 |
| 账号与业务数据 | PG 就绪走 `users` / `shares` / `runs` 表；否则写 `.data/auth-store.json`、`.data/shares.json`、`.data/local-db.json`（原子写盘，均已 gitignore） |
| 地图可视化 | 高德地图 JS API 2.0（前端瓦片 + 打点）+ 后端 REST 代理（place / route / geocode / locate，避免前端 Key 暴露）；未配置 Key 时自绘 SVG 示意图降级 |
| 运行器 | `tsx`（开发直接跑 `.ts`，无需编译） |
| 测试 | Node 内置 `node:test` + `node:assert/strict`（零额外依赖），92 条断言 |
| 运行时 | Node.js ≥ 20（已在 v24 验证） |
| 数据 | 苏州 / 杭州 / 南京三城 POI 快照（约 114 条向量）+ 17 城机场 / 火车站枢纽表 |

## 📂 项目结构

```
travel-agent-pi/
├─ src/
│  ├─ core/                 ← 核心引擎（与 pi 解耦，可独立测试）
│  │  ├─ models.ts          领域模型：POI / Traveler / Constraints / Itinerary / Disruption…
│  │  ├─ solver.ts          贪心排程器（时间窗 + 约束过滤 + 午休插入）
│  │  ├─ validator.ts       8 类硬约束断言 + verify_report
│  │  ├─ resilience.ts      扰动生成 / 韧性模拟（apply_disruption）
│  │  ├─ replanner.ts       最小改动重规划（原天补位 / 时间不重叠）
│  │  ├─ permissions.ts     工具分级 + before_tool_call 权限钩子
│  │  ├─ trace.ts           JSONL Trace + 指标聚合
│  │  ├─ dsl.ts             约束 DSL 解析 / 断言 / 导出
│  │  ├─ attribution.ts     因果归因（扰动→POI→约束→扣分）
│  │  └─ rng.ts             MT19937 实现，同 seed 扰动序列可复现
│  ├─ agents/               ← pi Agent 编排层
│  │  ├─ travel-tools.ts    7 个 AgentTool（read / reversible_write / external_action）
│  │  ├─ travel-agent.ts    createTravelAgent 工厂（系统提示 + 工具 + 权限钩子 + faux/真实模型）
│  │  ├─ session.ts         进程内单例，桥接无状态工具间的共享状态
│  │  ├─ workflow.ts        确定性工作流（不接 LLM，供测试复用）
│  │  └─ run-pi.ts          pi Agent 可运行入口
│  ├─ data/
│  │  └─ snapshot.ts        3 城 POI + 17 城交通枢纽 + 约束样本 + 备份池
│  ├─ evaluation.ts         指标计算（约束满足率 / 幻觉率 / 韧性分 / 脆弱点）
│  ├─ demo.ts               一键演示入口（确定性链路，零 Key）
│  ├─ hello.ts              入门示例
│  └─ server/               ← Web 服务层（Hono）
│     ├─ index.ts           入口：加载 .env → 初始化 DB → 启动 @hono/node-server
│     ├─ env.ts             .env 加载（Node 内置 process.loadEnvFile）
│     ├─ app.ts             32 条路由 + SSE（/api/run）+ 静态托管 SPA 回退 + 高德代理
│     ├─ auth.ts            账号 / 会话 / 角色守卫 / 个人信息（本地文件持久化）
│     ├─ shares.ts          只读分享（本地文件持久化）
│     ├─ db.ts              PG + PgVector / 本地文件后端双模：建表 / 种子 / 语义检索 / 运行记录
│     ├─ embeddings.ts      Embedding（智谱 embedding-3 / 本地哈希，512 维）
│     ├─ agent-runtime-run.ts 创建并驱动 pi Agent，事件映射为 SSE 协议
│     ├─ model-registry.ts  多模型注册中心（国内 8 家 + 国际 2 家）
│     ├─ amap.ts            高德 Web 服务代理（place / route / geocode / district / locate）
│     ├─ transport.ts       城际交通推荐（飞机 / 高铁 / 自驾 + 12306 车次）
│     ├─ railway.ts         12306 MCP 余票查询适配
│     ├─ flight.ts          航班数据源（ModelScope Hosted MCP）自检与查询
│     └─ weather.ts         天气预报（高德 → Open-Meteo 降级）
├─ web/                     ← 前端 Workbench（Rsbuild + React + Semi Design）
│  ├─ src/
│  │  ├─ App.tsx / UserApp.tsx / AdminApp.tsx   编排器 / 用户界面 / 管理后台
│  │  ├─ api.ts / auth.ts / storage.ts          接口封装 / 登录态 / 本地存储
│  │  ├─ meta.ts / theme.ts / regions.ts / segments.ts / proposal.ts
│  │  ├─ route-utils.ts / export-utils.ts / weather-adjust.ts
│  │  ├─ styles.css        玻璃拟态 + 极光渐变设计系统
│  │  ├─ index.tsx / env.d.ts
│  │  └─ components/       21 个组件：
│  │     Header / TopBar / Sidebar / LoginPage / ProfileModal / ControlPanel /
│  │     PreferencePanel / BudgetPanel / ProposalCard / IntercityPanel /
│  │     MapView / MapPoiSearch / ManualRoute / ItineraryTimeline / ReplanPanel /
│  │     StressPanel / WeatherForecast / MetricsStrip / EventStream / ExportBar / SharedPage
│  ├─ index.html
│  ├─ .env.example         前端 VITE_ 变量模板（也可统一放根目录 .env）
│  └─ rsbuild.config.ts    端口 5173，/api 代理到 http://localhost:8787
├─ tests/
│  ├─ core.test.ts          15 条核心断言
│  ├─ resilience_full.test.ts  15 条韧性 + 归因断言
│  ├─ api.test.ts           44 条后端 API 集成测试（无需启动服务 / 浏览器 / 网络）
│  ├─ storage.test.ts       本地草稿恢复 / 偏好重置 / 脏数据收敛回归
│  ├─ route-utils.test.ts   手动路线费用补齐与同行人数汇总回归
│  └─ preferences.test.ts   旅行偏好 → 求解器硬约束 / faux Agent 链路回归
├─ scripts/
│  ├─ gate-check.ts         回归门禁（tsc + 全套测试 + demo 指标）
│  └─ init-pg.sql           容器首次初始化：CREATE EXTENSION vector
├─ docker-compose.yml       PostgreSQL 17 + pgvector 容器（可选）
├─ .env.example             环境变量模板（DB / Embedding / 各模型 Key / 高德 / MCP）
├─ traces/                  ← 运行产物（自动生成，已 gitignore）
├─ .data/                   ← 本地兜底数据（自动生成，含密码哈希，已 gitignore）
├─ dist/ / web/dist/        ← 编译 / 构建产物（已 gitignore）
├─ package.json / tsconfig.json
└─ README.md
```

## 🚀 快速开始

### 环境要求
- Node.js ≥ 20、npm
- **PostgreSQL / Docker 不是必需项**：没装也能跑全部功能（自动走本地文件后端）
- 高德 Key、各种大模型 Key 均为可选项，零配置也能完整演示

> Windows PowerShell 下若 `npm` 命令不可用，把下文所有 `npm` 换成 `npm.cmd` 即可。

### 1. 安装依赖
```bash
cd travel-agent-pi
npm install
npm --prefix web install
```

### 2. 一键演示（零 Key，最稳）
```bash
npm run demo
```
输出依次展示：行程表 → 评估指标 → 权限钩子 → 抗扰动重规划 → Trace 摘要。
关键指标基线：约束满足率 **100%** / 幻觉率 **0%** / 韧性分 **100%** / `book_ticket` 被拦截 / 改动节点数 **4**。

### 3. pi Agent 端到端（默认 faux 模式，无需 Key）
```bash
npm run pi
```
Agent 会按 `plan_trip → validate_plan → stress_test → book_ticket(被拦截) → 总结` 调度工具，事件流写入 `traces/`。

接真实模型（模型自主决定工具调用顺序，默认 `openai/gpt-4o-mini`）：
```bash
OPENAI_API_KEY="你的 key" npm run pi      # Linux / macOS
$env:OPENAI_API_KEY="你的 key"; npm run pi   # Windows PowerShell
```

### 4. 编译为 JS 后运行
```bash
npm run build      # tsc → dist/
node dist/demo.js
```

## 🌐 启动 Web UI（可视化工作台）

前端在 `web/` 目录，后端 `src/server/` 提供 HTTP + SSE 接口，单仓协同。

> **执行模型**：`POST /api/run` 创建一个真实的 `@mariozechner/pi-agent-core` Agent Runtime 实例并驱动它运行——由模型自主调度工具（`plan_trip` / `validate_plan` / `stress_test` / `replan` / `book_ticket`），`agent.subscribe` 的生命周期事件实时映射为 SSE 推给前端。未配置模型 Key → 回退 **faux provider 预设脚本**，但仍经过完整 Agent 循环（工具真实执行、事件序列一致）。

### 数据库：可选，未配置自动降级
```bash
npm run db:up      # 可选：docker compose up -d 启动 PostgreSQL(pgvector) :5432
npm run db:logs
```
服务启动时会自动建表、导入 POI 向量（幂等）。**若 PG 连不上**（未装 Docker、端口不通等）：

- 服务**照常启动**，启动日志显示 `语义存储 ✅ 本地文件后端`，不再打印「不可用」报错；
- `/api/search` 语义检索、运行记录、账号、个人信息、分享链接**全部可用**，数据写入 `.data/` 下的 JSON 文件；
- 以后装好 PostgreSQL 并启动，服务**自动切回 PG**，无需改代码；
- 已有外部 PostgreSQL（装了 pgvector）时设置 `DATABASE_URL=postgres://user:pass@host:5432/db` 即可跳过 Docker。

### 开发模式（热更新，两个终端）
```bash
npm run dev:server    # 后端 :8787（Hono + SSE）
npm run dev:web       # 前端 :5173（/api 自动代理到 :8787）
```
打开 http://localhost:5173 。

### 生产模式（后端单端口托管前端）
```bash
npm run build:web     # 产出 web/dist
npm start             # :8787 同时静态托管 web/dist（SPA 回退，含 /s/:slug）
```
打开 http://localhost:8787 即可，无需单独起前端。

### 默认账号与权限

首次启动会内置两个账号（密码用 scrypt 加盐哈希，不存明文）：

| 账号 | 密码 | 角色 | 可访问 |
|---|---|---|---|
| `admin` | `admin123` | admin | 全部接口 + 管理后台（用户管理 / 运行记录） |
| `user` | `user123` | user | 规划、地图、个人信息、分享 |

也可在登录页自行注册（默认 `user` 角色）。权限在**后端**最终裁决：未登录访问数据 / 规划接口返回 401，普通用户访问管理接口返回 403。

**个人信息**：登录后在「个人信息」中设置昵称、出发城市、简介，保存后写盘；刷新页面、重启服务都会自动回填，且不同用户互不串号。

**只读分享**：行程生成后可创建公开短链 `/s/:slug`，未登录访客可直接查看；分享记录同样落盘，服务重启后旧链接仍有效。

### 数据源：在线 / 离线

| 模式 | 景点 / 餐厅 / 酒店 | 机场 / 火车站 | 说明 |
|---|---|---|---|
| 在线（默认） | 后端代理高德全量 POI，任意城市 | 高德实时数据 | 需 `AMAP_KEY`；未配置时自动按离线逻辑处理 |
| 离线 / 本地 | 内置快照：苏州 / 杭州 / 南京 | **17 城全国枢纽表** | 北京、上海、广州、深圳、成都、西安、重庆、武汉、青岛、天津、长沙、厦门、昆明、三亚 + 苏杭宁 |

离线模式下未覆盖的城市会明确返回 `unavailable: true`，**不会**把别城市的 POI 冒充目标城市展示。

### 多模型配置（可选，零配置也能跑演示）

前端模型下拉显示所有已配置模型。在 `.env` 填入任一 Key，对应模型即变为可用（`configured: true`）：

| 模型 | 环境变量 | 兼容端点 |
|---|---|---|
| 🇨🇳 DeepSeek / R1 | `DEEPSEEK_API_KEY` | `https://api.deepseek.com` |
| 🇨🇳 智谱 GLM-4 | `ZHIPU_API_KEY` | `https://open.bigmodel.cn/api/paas/v4` |
| 🇨🇳 Kimi | `MOONSHOT_API_KEY` | `https://api.moonshot.cn/v1` |
| 🇨🇳 通义千问 | `DASHSCOPE_API_KEY` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 🇨🇳 豆包 | `ARK_API_KEY` | `https://ark.cn-beijing.volces.com/api/v3` |
| 🇨🇳 文心一言 | `QIANFAN_API_KEY` | `https://qianfan.baidubce.com/v2` |
| 🇨🇳 阶跃星辰 | `STEPFUN_API_KEY` | `https://api.stepfun.com/v1` |
| 🌍 OpenAI | `OPENAI_API_KEY` | 官方 |
| 🌍 Anthropic | `ANTHROPIC_API_KEY` | 官方 |

> 原理：pi-ai 的 `openai-completions` provider 支持 `model.baseUrl`，国内模型均为 OpenAI 兼容端点，构造自定义 `Model` 后直连，无需额外 SDK。注册中心见 `src/server/model-registry.ts`。
> 所有 Key 写进项目根 `.env`（参考 `.env.example`），服务启动时自动加载。模型调用失败（余额不足 / 鉴权失败）会以红色错误条明确上报，不会静默成空成功。

### 🗺 地图接入（高德地图，可选）

- **前端渲染**：浏览器加载高德 JS API 2.0 瓦片并打点；相邻景点的路线走后端代理，用高德 `polyline` 画真实步行路径。
- **后端代理**：`/api/amap/*` 转发高德 Web 服务 REST API，Key 仅存服务端，不回传前端。
- **优雅降级**：未配置任何 Key 时自动渲染自绘 SVG 示意图（基于本地 POI 经纬度投影、按天着色编号）。

配置方式：
1. 申请：https://console.amap.com/ → 应用管理 → 创建应用
2. **后端 Web 服务 Key**：根目录 `.env` 填 `AMAP_KEY=...`
3. **前端 Web 端(JS API) Key + 安全密钥**：填 `VITE_AMAP_KEY` / `VITE_AMAP_SECURITY_CODE`（根目录 `.env` 或复制 `web/.env.example` 为 `web/.env`），改完重新 `npm run build:web`
   > 前端这两个值会出现在浏览器端，请在高德控制台配置安全密钥 + 域名白名单（referer）。

两种 Key 可只配其一；都不配 → 示意图。

### 城际交通 / 天气 / 航班（可选增强）

- `/api/transport`：出发地 → 目的地的飞机 / 高铁 / 自驾推荐，`date=YYYY-MM-DD` 时接 12306 实时车次（`RAILWAY_MCP_URL`），未配置则回退估算。
- `/api/weather`：出行天气预报，高德优先 → Open-Meteo 降级 → 都失败返回 `forecast: null` 由前端不渲染。
- `/api/flight/health`：航班数据源自检（`FLIGHT_MCP_URL` + `FLIGHT_MCP_TOOL`，详见 `.env.example` 注释），配完可立刻验证连通性与工具列表。

## 📡 HTTP API 端点

除标注「公开」外均需 `Authorization: Bearer <token>`；标注「管理员」的仅 `admin` 可访问。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/health` | 公开 | 健康检查：DB / 语义后端 / 前端构建状态 |
| GET | `/api/models` | 公开 | 可用模型列表（含 `configured`） |
| GET | `/api/cities?source=` | 公开 | 城市列表（local / online） |
| POST | `/api/auth/login` | 公开 | 登录，返回 token |
| POST | `/api/auth/register` | 公开 | 注册 |
| GET | `/api/auth/me` | 登录 | 当前用户 |
| POST | `/api/auth/logout` | 登录 | 登出（token 立即失效） |
| GET | `/api/profile` | 登录 | 读取个人信息 |
| PUT | `/api/profile` | 登录 | 保存个人信息（落盘持久化） |
| POST | `/api/share` | 登录 | 创建只读分享，返回 `/s/:slug` |
| GET | `/api/share/:slug` | 公开 | 查看分享（无需登录） |
| GET | `/api/pois?city=&source=` | 登录 | 城市 POI 列表 |
| GET | `/api/poi/search?q=&city=&source=` | 登录 | 地图分类搜索（交通枢纽离线走全国表） |
| GET | `/api/transport?from=&to=&date=` | 登录 | 城际交通推荐 |
| GET | `/api/flight/health` | 登录 | 航班数据源自检 |
| GET | `/api/weather?city=&days=&start=` | 登录 | 出行天气预报 |
| GET | `/api/search?q=&city=&limit=` | 登录 | 语义检索 POI（PgVector 或本地文件后端） |
| POST | `/api/run` | 登录 | **SSE 流**：驱动 pi Agent Runtime，逐帧推事件 + 行程 + 指标 |
| GET | `/api/amap/config` | 登录 | 高德是否已配置（不泄露 Key） |
| GET | `/api/amap/provinces` | 登录 | 省级行政区列表 |
| GET | `/api/amap/city?q=` | 登录 | 城市联想 |
| GET | `/api/amap/place?keywords=&city=` | 登录 | 地点搜索 |
| GET | `/api/amap/route?origin=&destination=&type=` | 登录 | 路径规划（walking / driving，`lng,lat`） |
| GET | `/api/amap/locate?q=` | 登录 | 搜索框回车定位（地名 → 视野中心） |
| GET | `/api/amap/geocode?address=&city=` | 登录 | 地理编码 |
| GET | `/api/admin/users` | 管理员 | 用户列表（不含密码哈希） |
| DELETE | `/api/admin/users/:id` | 管理员 | 删除用户 |
| GET | `/api/admin/runs?limit=` | 管理员 | 运行记录 |
| GET | `/api/runs?limit=` | 管理员 | 运行记录（同上） |
| GET | `/*` | 公开 | 静态托管 `web/dist`（SPA 回退，含 `/s/:slug`）；未匹配的 `/api/*` 返回 JSON 404 |

## 📜 命令一览

| 命令 | 作用 |
|---|---|
| `npm run demo` | 一键演示（确定性链路，零 Key） |
| `npm start` / `npm run server` | 启动 Hono 服务 :8787（SSE + 静态托管 `web/dist`） |
| `npm run dev:server` | 后端热重载（tsx watch） |
| `npm run dev:web` | 前端 dev server :5173（/api 代理到 :8787） |
| `npm run build:web` | 构建前端到 `web/dist` |
| `npm run build` | `tsc` 编译后端到 `dist/` |
| `npm run pi` | 启动 pi Agent（faux / 真实模型自适应） |
| `npm run db:up` / `db:down` / `db:logs` | 可选：启停 / 查看 PostgreSQL(pgvector) 容器 |
| `npm test` | 全套 92 条断言（core 15 + resilience 15 + api 45 + storage 9 + route-utils 3 + preferences 5） |
| `npm run test:api` | 单独跑后端 API 集成测试 |
| `npm run typecheck` | `tsc --noEmit` 类型检查 |
| `npm run gate` | **交付门禁**：类型检查 + 全套测试 + demo 指标，全过才 exit 0 |
| `npm run clean:traces` | 清理 `traces/` 运行残留（保留 `metrics_index.json`） |

## 🧪 测试与回归门禁

```bash
npm run gate
```

三道关，任一失败即 `exit 1`：

1. **类型检查** — `tsc --noEmit` 干净通过
2. **测试套件** — `tests/` 下全部断言通过且 0 失败（不硬编码条数，只要求不少于 30 条）
   - `core.test.ts`：求解器 / 硬约束 / 幻觉检测 / 韧性 / 重规划 / 权限 / Trace
   - `resilience_full.test.ts`：20 条扩展扰动集 / 可复现性 / 至少 15 条扰动确实影响行程
   - `api.test.ts`：**无需启动服务、无需浏览器、无需网络**，用 Hono `app.request()` 覆盖 32 条路由、鉴权与角色守卫、个人信息持久化与隔离、离线交通枢纽、本地文件语义后端、分享落盘、CORS 预检、SPA 回退
   - `storage.test.ts`：内存 `localStorage` 模拟「保存 → 刷新 → 恢复」，覆盖偏好全字段（含中文）、损坏 JSON、残缺数据收敛、清空、收藏往返
   - `route-utils.test.ts`：手动路线缺价时从 POI 目录补齐，费用按同行人数汇总，最终预算不为 0
   - `preferences.test.ts`：人群 / 节奏 / 预算 / 台阶 / 午休 / 下午室内 / 必去 / 避开真实进入求解器，并验证 faux Agent 链路传参
3. **demo 指标门禁** — 约束 ≥ 90% / 幻觉 ≤ 10% / 韧性 ≥ 95% / 改动节点 > 0 / `book_ticket` 被拦截

## 🧩 Agent 工具清单

7 个工具，对应 3 个权限级别（见 `src/core/permissions.ts`）：

| 工具 | 级别 | 说明 |
|---|---|---|
| `list_cities` | read | 列出支持规划的城市 |
| `load_pois` | read | 加载指定城市的 POI 快照 |
| `validate_plan` | read | 校验当前行程的约束满足情况 |
| `stress_test` | read | 注入扰动并计算韧性分 + 归因 |
| `plan_trip` | reversible_write | 根据约束生成行程 |
| `replan` | reversible_write | 针对给定扰动最小改动重规划 |
| `book_ticket` | external_action | 订票等外部动作，**未获人工批准一律拦截** |

## 🏗 设计要点

- **单 Agent + 多工具**：pi 不提供 LangGraph 式状态图编排，这里用极简范式——一个 Agent + 一组工具，由系统提示引导工作流。
- **核心引擎与框架解耦**：`src/core/` 不依赖 pi，可独立用 `node:test` 测试；`src/agents/` 只是把引擎包成 pi 工具。
- **RNG 确定性**：`src/core/rng.ts` 自实现 MT19937，与 CPython `random.Random` 字节级一致，同 seed 下扰动序列完全可复现，压测结果可审计、可回归。
- **重规划的真实性**：demo 针对「行程中实际排入的景点」构造扰动（全量 POI 随机抽样会命中 0 项），输出文案全部由引擎结果生成，不硬编码；雨天扰动对室外与半室外景点均生效，补位优先回填原来的天。
- **降级优先、零 Docker 可用**：PG / 高德 Key / 模型 Key 三处均可缺失，各自有明确降级路径；本地文件后端用原子写（临时文件 + 重命名）避免写一半损坏。
- **安全默认**：`book_ticket` 等外部动作默认拒绝；密码 scrypt 加盐哈希；API Key 仅存服务端；`.env` 与 `.data/` 均已 gitignore。
- **SPA 与 API 分离**：`/api/*` 未匹配时返回结构化 JSON 404，不会被 SPA 回退吞成 HTML。

## 📊 基线指标（苏州 3 天，`npm run demo` 实测）

| 指标 | 基线值 |
|---|---|
| 行程项数 | 9 |
| 硬约束断言 | 31 / 31 通过 |
| 约束满足率 | 100% |
| 幻觉率 | 0% |
| 韧性分（5 条精简扰动集） | 100% |
| 韧性分（扩展 20 条扰动集） | ≥ 50%，测试保证 ≥ 15/20 条扰动确实影响行程 |
| 基线总花费 | ¥1920 / 预算 ¥6000 |
| 降雨重规划改动节点 | 4（移除 2 项 + 原天补入 2 项） |

## ✅ 交付验收清单

一键复现全部检查：

```bash
npm run typecheck && npm test && npm run gate && npm run build && npm run build:web
```

| 检查项 | 命令 | 期望 |
|---|---|---|
| 后端类型检查 | `npm run typecheck` | 0 错误 |
| 全量测试 | `npm test` | 92 / 92 通过，0 失败 |
| 回归门禁 | `npm run gate` | 三关全过，`✅ 可交付` |
| 后端编译 | `npm run build` + `node dist/demo.js` | 编译产物可直接运行 |
| 前端构建 | `npm run build:web` | 产出 `web/dist/index.html` |
| 干净启动 | `npm start` → `GET /api/health` | `ok: true`、`semanticReady: true`、`frontendBuilt: true` |
| 页面可达 | `GET http://localhost:8787` | 返回 SPA HTML；`/s/:slug` 正常回退 |
| 核心链路 | 登录后 `POST /api/run`（faux） | SSE 出现 `run_started` → 事件流 → `run_completed` |
| 偏好重置 | 浏览器选好旅行偏好 → **刷新页面** | 城市 / 日期 / 手动选点恢复；偏好与补充描述回到默认值 |
| 持久化回归 | `node --import tsx --test tests/storage.test.ts` | 9 条全通过 |

> 数据库、Docker、各种 API Key 均非必需；上述验收可在纯本地零配置环境下完成。

### 本次验收结果（2026-11-26）

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 0 错误 |
| `npm test` | ✅ 92 / 92 通过（core 15 + resilience 15 + api 45 + storage 9 + route-utils 3 + preferences 5） |
| `npm run gate` | ✅ 三关全过，`✅ 可交付`：约束 100% / 幻觉 0% / 韧性 100% / 改动 4 节点 / `book_ticket` 拦截 |
| `npm run build` + `node dist/demo.js` | ✅ 编译产物可直接运行 |
| `npm run build:web` | ✅ 产出 `web/dist/index.html` |
| 干净启动 + 真实服务端到端冒烟 | ✅ 13 / 13 通过（健康检查 / 登录 / SPA 首页与 `/s/:slug` 回退 / 未知 API JSON 404 / CORS 允许 PUT / 语义检索 / 离线枢纽 / 分享落盘 / **SSE 11 个事件** / 运行记录） |

验收环境：Windows + Node 24，**未启动 PostgreSQL / Docker**（服务自动使用本地文件后端），未配置任何外部 API Key 即完成上述全部检查。

## 🔭 可选扩展

> 现状：`/api/run` 已驱动真实 pi Agent Runtime（选已配置模型 → 真实 LLM 自主调度工具；未配置 → faux 回退，仍走完整 Agent 循环）。以下为可继续增强的方向：

- **多轮对话式规划**：当前每次运行是单次 `agent.prompt` + `waitForIdle` 后即结束；可保留 Agent 会话跨多轮交互，实现「改改第三天」式的自然语言迭代。
- **权限审批 UI**：`approver` 目前恒为 `false`（`book_ticket` 一律拦截演示）；可在前端加审批弹窗，把人工决策回传给 Agent。
- **Trace 回放面板**：`traces/metrics_index.json` 已聚合历史运行指标，可在前端加历史记录回放。
- **运行时入口**：`src/server/agent-runtime-run.ts`（Agent 创建 + 事件映射）与 `src/agents/travel-agent.ts`（工厂，支持传入自定义 `Model` + `apiKey`）。

## 📄 License

MIT
