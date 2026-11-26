/**
 * 服务入口 —— 加载 .env → 初始化 PgVector → 启动 Hono（@hono/node-server）。
 *
 * 注意：`./env.js` 必须最先导入，确保 DATABASE_URL 等环境变量在 db.ts 读取前已就绪。
 */
import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import app, { WEB_DIST } from "./app.js";
import { initDb, getDbStatus, closeDb } from "./db.js";
import { initAuth } from "./auth.js";

const PORT = Number(process.env.PORT) || 8787;

// 初始化数据库（失败会降级，不阻塞启动）
await initDb();
// 初始化鉴权：PG 就绪时写默认账号到 users 表；否则使用内存账号
await initAuth();

serve({ fetch: app.fetch, port: PORT }, (info) => {
  const db = getDbStatus();
  console.log(`\n🚀 travel-agent-pi server (Hono) 已启动: http://localhost:${info.port}`);
  console.log(`   健康检查:  http://localhost:${info.port}/api/health`);
  console.log(`   模型列表:  http://localhost:${info.port}/api/models`);
  console.log(`   语义检索:  http://localhost:${info.port}/api/search?q=适合老人的室内景点`);
  console.log(`   运行记录:  http://localhost:${info.port}/api/runs`);
  console.log(`   Runtime:   POST http://localhost:${info.port}/api/run  (SSE)`);
  console.log(
    `   语义存储:  ${
      db.store === "postgres"
        ? `✅ PostgreSQL + PgVector（embedding=${db.provider}, dim=${db.dim}）`
        : db.store === "local-file"
          ? `✅ 本地文件后端（${db.dim} 维向量，无需 Docker；PG 就绪后自动切换）`
          : `⚠️ 未就绪（${db.error ?? "未连接"}）`
    }`,
  );
  if (fs.existsSync(path.join(WEB_DIST, "index.html"))) {
    console.log(`   前端页面:  http://localhost:${info.port}/  （已托管 web/dist）`);
  } else {
    console.log(`   前端页面:  未构建，开发时用 npm run dev:web（Rsbuild dev server）`);
  }
  console.log("");
});

// 优雅退出：关闭连接池
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n[server] 收到 ${sig}，正在关闭...`);
    void closeDb().finally(() => process.exit(0));
  });
}
