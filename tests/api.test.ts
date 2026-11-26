/**
 * 后端 API 集成测试 —— 全量路由回归。
 *
 * 特点：直接用 Hono 的 app.request() 驱动路由，无需启动服务、无需浏览器、无需外部网络，
 * 因此 `npm test` 可在任意环境一键跑完（含 CI）。
 *
 * 覆盖：公开端点 / 鉴权与角色守卫 / 个人信息持久化与隔离 / 离线交通枢纽（全国内置表）/
 *       PG 不可用时的本地文件语义后端 / 只读分享（含落盘持久化）/
 *       参数校验与优雅降级 / CORS 预检 / SPA 回退 / db 层单元行为。
 *
 * 运行：node --import tsx --test tests/api.test.ts
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "../src/server/env.js"; // 必须先于 db.ts 加载 .env
import app from "../src/server/app.js";
import {
  initDb,
  closeDb,
  isSemanticReady,
  getDbStatus,
  searchPois,
  recentRuns,
} from "../src/server/db.js";
import { flightCityCode } from "../src/server/flight.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHARES_FILE = path.join(ROOT, ".data", "shares.json");

type Json = any;

interface CallOpts {
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
}

async function call(method: string, url: string, opts: CallOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  return app.request(url, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

const asJson = async (res: Response): Promise<Json> => (await res.json()) as Json;
const GET = (url: string, token?: string) => call("GET", url, { token });
const POST = (url: string, body: unknown, token?: string) => call("POST", url, { body, token });
const PUT = (url: string, body: unknown, token?: string) => call("PUT", url, { body, token });
const DEL = (url: string, token?: string) => call("DELETE", url, { token });

const TEMP_USER = `apitest_${Date.now().toString(36)}`;
const TEMP_PW = "Apitest!2026";
let adminToken = "";
let userToken = "";
let tempUserId = 0;
let createdSlug = "";

before(async () => {
  // PG 连不上时会自动启用本地文件向量后端（与真实启动行为一致）
  await initDb();
  const res = await POST("/api/auth/login", { username: "admin", password: "admin123" });
  assert.equal(res.status, 200, "默认管理员账号应可登录");
  adminToken = (await asJson(res)).token;
  assert.ok(adminToken, "登录应返回 token");
});

after(async () => {
  // 清理测试账号：同时把 .data/auth-store.json 里的测试用户删掉
  if (tempUserId && adminToken) {
    try {
      await DEL(`/api/admin/users/${tempUserId}`, adminToken);
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
  // 清理测试分享：从本地分享文件里移除本次创建的 slug
  try {
    if (createdSlug && fs.existsSync(SHARES_FILE)) {
      const data = JSON.parse(fs.readFileSync(SHARES_FILE, "utf8"));
      if (Array.isArray(data?.shares)) {
        data.shares = data.shares.filter((s: Json) => s.slug !== createdSlug);
        fs.writeFileSync(SHARES_FILE, JSON.stringify(data), "utf8");
      }
    }
  } catch {
    /* 清理失败不影响测试结论 */
  }
  await closeDb();
});

// ─────────────────────────── 公开端点 ───────────────────────────

describe("[api] 公开端点", () => {
  test("健康检查返回 ok 与完整状态", async () => {
    const res = await GET("/api/health");
    assert.equal(res.status, 200);
    const j = await asJson(res);
    assert.equal(j.ok, true);
    assert.equal(j.service, "travel-agent-pi");
    assert.equal(j.runtime, "hono");
    assert.equal(typeof j.frontendBuilt, "boolean");
    assert.ok(j.db && typeof j.db === "object");
    assert.equal(typeof j.db.semanticReady, "boolean");
  });

  test("模型列表非空且带 configured 标记", async () => {
    const res = await GET("/api/models");
    assert.equal(res.status, 200);
    const j = await asJson(res);
    assert.ok(Array.isArray(j.models) && j.models.length > 0);
    assert.equal(typeof j.total, "number");
    assert.equal(typeof j.models[0].configured, "boolean");
  });

  test("城市列表：本地 / 线上两种数据源", async () => {
    const local = await asJson(await GET("/api/cities"));
    assert.equal(local.source, "local");
    assert.ok(Array.isArray(local.cities) && local.cities.length >= 3);

    const online = await asJson(await GET("/api/cities?source=online"));
    assert.equal(online.source, "online");
    assert.ok(online.cities.includes("北京"));
  });

  test("未知 API 路径返回 JSON 404", async () => {
    const res = await GET("/api/definitely-not-exist");
    assert.equal(res.status, 404);
    const j = await asJson(res);
    assert.equal(j.error, "not found");
  });

  test("语义后端在 PG 不可用时仍可用（本地文件降级）", async () => {
    const j = await asJson(await GET("/api/health"));
    assert.equal(j.db.semanticReady, true, "PG 未连接时本地文件后端必须顶上");
    assert.ok(["postgres", "local-file"].includes(j.db.store));
    assert.equal(isSemanticReady(), true);
  });
});

// ─────────────────────────── 鉴权与角色守卫 ───────────────────────────

describe("[api] 鉴权与角色守卫", () => {
  test("未登录访问受保护端点一律 401", async () => {
    for (const url of [
      "/api/profile",
      "/api/pois?city=苏州&source=local",
      "/api/poi/search?q=机场&city=北京&source=local",
      "/api/search?q=古镇",
      "/api/runs",
      "/api/amap/config",
    ]) {
      const res = await GET(url);
      assert.equal(res.status, 401, `${url} 应要求登录`);
    }
  });

  test("未登录调用 /api/run 返回 401", async () => {
    const res = await POST("/api/run", { city: "苏州" });
    assert.equal(res.status, 401);
  });

  test("错误密码 / 缺字段 / 非法 JSON 分别返回 401、400、400", async () => {
    assert.equal((await POST("/api/auth/login", { username: "admin", password: "wrong" })).status, 401);
    assert.equal((await POST("/api/auth/login", { username: "admin" })).status, 400);
    const bad = await call("POST", "/api/auth/login", { headers: { "Content-Type": "application/json" } });
    assert.equal(bad.status, 400);
  });

  test("注册：成功 / 重复 / 空用户名", async () => {
    const ok = await POST("/api/auth/register", { username: TEMP_USER, password: TEMP_PW });
    const j = await asJson(ok);
    assert.equal(ok.status, 200, `注册失败：${JSON.stringify(j)}`);
    assert.equal(j.ok, true);
    tempUserId = Number(j.user?.id);
    assert.ok(Number.isFinite(tempUserId) && tempUserId > 0);

    assert.equal((await POST("/api/auth/register", { username: TEMP_USER, password: TEMP_PW })).status, 400);
    assert.equal((await POST("/api/auth/register", { username: "", password: TEMP_PW })).status, 400);
  });

  test("登录新用户并读取当前用户", async () => {
    const res = await POST("/api/auth/login", { username: TEMP_USER, password: TEMP_PW });
    assert.equal(res.status, 200);
    const j = await asJson(res);
    assert.ok(j.token);
    assert.equal(j.user.role, "user");
    userToken = j.token;

    const me = await asJson(await GET("/api/auth/me", userToken));
    assert.equal(me.user.username, TEMP_USER);
    assert.equal(me.user.role, "user");
  });

  test("普通用户不能访问管理接口（403）", async () => {
    assert.equal((await GET("/api/admin/users", userToken)).status, 403);
    assert.equal((await GET("/api/runs", userToken)).status, 403);
  });

  test("管理员可列出用户（不含密码哈希）", async () => {
    const res = await GET("/api/admin/users", adminToken);
    assert.equal(res.status, 200);
    const j = await asJson(res);
    assert.ok(j.count >= 2 && Array.isArray(j.users));
    assert.ok(j.users.some((u: Json) => u.username === TEMP_USER));
    for (const u of j.users) {
      assert.equal("password_hash" in u, false, "用户列表不得泄露密码哈希");
    }
  });

  test("登出后 token 立即失效", async () => {
    const login = await asJson(await POST("/api/auth/login", { username: TEMP_USER, password: TEMP_PW }));
    const t = login.token;
    assert.equal((await GET("/api/auth/me", t)).status, 200);
    assert.equal((await POST("/api/auth/logout", {}, t)).status, 200);
    assert.equal((await GET("/api/auth/me", t)).status, 401);
  });
});

// ─────────────────────────── 个人信息：持久化与隔离 ───────────────────────────

describe("[api] 个人信息：设置一次即记住且用户间隔离", () => {
  const profile = { nickname: "小途_测试", city: "苏州", bio: "喜欢古镇与评弹" };

  test("保存个人信息并回显", async () => {
    const res = await PUT("/api/profile", profile, userToken);
    assert.equal(res.status, 200);
    const j = await asJson(res);
    assert.equal(j.nickname, profile.nickname);
    assert.equal(j.city, profile.city);
    assert.equal(j.bio, profile.bio);
  });

  test("读取返回已保存值", async () => {
    const j = await asJson(await GET("/api/profile", userToken));
    assert.equal(j.nickname, profile.nickname);
    assert.equal(j.city, profile.city);
    assert.equal(j.bio, profile.bio);
  });

  test("跨用户互不串号", async () => {
    const adminProfile = await asJson(await GET("/api/profile", adminToken));
    assert.notEqual(adminProfile.nickname, profile.nickname);
  });

  test("重新登录（新会话）后仍保留 → 已落盘", async () => {
    const relogin = await asJson(await POST("/api/auth/login", { username: TEMP_USER, password: TEMP_PW }));
    const j = await asJson(await GET("/api/profile", relogin.token));
    assert.equal(j.nickname, profile.nickname);
    assert.equal(j.city, profile.city);
  });
});

// ─────────────────────────── 离线交通枢纽（全国内置表） ───────────────────────────

describe("[api] 离线模式：任意主要城市的机场 / 火车站都能高亮", () => {
  for (const city of ["北京", "上海", "青岛", "三亚"]) {
    for (const cat of ["机场", "火车站"]) {
      test(`${city} · ${cat} 有数据且分类正确`, async () => {
        const res = await GET(
          `/api/poi/search?q=${encodeURIComponent(cat)}&city=${encodeURIComponent(city)}&source=local`,
          userToken,
        );
        assert.equal(res.status, 200);
        const j = await asJson(res);
        assert.equal(j.source, "local");
        assert.ok(Array.isArray(j.pois) && j.pois.length > 0, `${city} 的${cat}不应为空`);
        for (const p of j.pois) {
          assert.equal(p.category, cat);
          assert.equal(typeof p.name, "string");
          assert.ok(Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)), "坐标须有效");
        }
      });
    }
  }

  test("未覆盖城市的其它分类明确不可用，不回退苏州数据", async () => {
    const j = await asJson(
      await GET("/api/poi/search?q=餐厅&city=北京&source=local", userToken),
    );
    assert.equal(j.unavailable, true);
    assert.equal(j.pois.length, 0);
  });

  test("本地 POI 列表：内置城市有数据，非内置城市返回空", async () => {
    const su = await asJson(await GET("/api/pois?city=苏州&source=local", userToken));
    assert.equal(su.count > 0, true);
    const bj = await asJson(await GET("/api/pois?city=北京&source=local", userToken));
    assert.equal(bj.count, 0);
    assert.equal(bj.unavailable, true);
  });
});

// ─────────────────────────── 语义检索：本地文件后端 ───────────────────────────

describe("[api] 语义检索：PG 未就绪时本地文件后端仍可用", () => {
  test("/api/search 返回命中且按相似度降序", async () => {
    const res = await GET("/api/search?q=适合老人的室内景点&limit=5", userToken);
    assert.equal(res.status, 200, "本地文件后端下 /api/search 不应再返回 503");
    const j = await asJson(res);
    assert.ok(j.count > 0);
    for (let i = 1; i < j.hits.length; i++) {
      assert.ok(j.hits[i - 1].score >= j.hits[i].score, "score 必须降序");
    }
    assert.ok(typeof j.hits[0].name === "string");
  });

  test("city 过滤生效", async () => {
    const j = await asJson(await GET("/api/search?q=古镇&city=苏州&limit=8", userToken));
    assert.ok(j.count > 0);
    for (const h of j.hits) assert.equal(h.city, "苏州");
  });

  test("缺少 q 返回 400", async () => {
    assert.equal((await GET("/api/search", userToken)).status, 400);
  });

  test("db 层函数直接可用", async () => {
    const hits = await searchPois("园林", "苏州", 3);
    assert.equal(hits.length, 3);
    assert.equal(typeof hits[0].score, "number");
    assert.ok(Array.isArray(await recentRuns(5)));
    assert.equal(typeof getDbStatus().store, "string");
  });
});

// ─────────────────────────── 只读分享（含落盘持久化） ───────────────────────────

describe("[api] 只读分享：创建 / 公开查看 / 持久化", () => {
  const itinerary = {
    days: 2,
    items: [{ poi: { id: "s1", name: "拙政园" }, day: 1, start: "09:00" }],
  };

  test("未登录不能创建、空行程不能创建", async () => {
    assert.equal((await POST("/api/share", { itinerary })).status, 401);
    assert.equal((await POST("/api/share", { itinerary: { items: [] } }, userToken)).status, 400);
  });

  test("创建分享并返回 slug", async () => {
    const res = await POST(
      "/api/share",
      { title: "苏州两日", city: "苏州", days: 2, itinerary },
      userToken,
    );
    assert.equal(res.status, 200);
    const j = await asJson(res);
    assert.equal(j.ok, true);
    assert.match(j.slug, /^[A-Za-z0-9_-]{4,32}$/);
    assert.equal(j.path, `/s/${j.slug}`);
    createdSlug = j.slug;
  });

  test("未登录访客可读取分享内容", async () => {
    const res = await GET(`/api/share/${createdSlug}`);
    assert.equal(res.status, 200);
    const j = await asJson(res);
    assert.equal(j.city, "苏州");
    assert.equal(j.itinerary.items[0].poi.name, "拙政园");
  });

  test("无效 / 不存在的 slug 返回 400 / 404", async () => {
    assert.equal((await GET("/api/share/bad!!slug")).status, 400);
    assert.equal((await GET("/api/share/zzzznotexist9999")).status, 404);
  });

  test("分享已落盘：重启后仍可读取（本地文件后端）", async () => {
    assert.ok(fs.existsSync(SHARES_FILE), ".data/shares.json 应存在");
    const data = JSON.parse(fs.readFileSync(SHARES_FILE, "utf8"));
    assert.ok(
      Array.isArray(data.shares) && data.shares.some((s: Json) => s.slug === createdSlug),
      "分享记录必须写入本地文件",
    );
  });
});

// ─────────────────────────── 参数校验 / 降级 / 基础设施 ───────────────────────────

describe("[api] 参数校验、优雅降级与基础设施", () => {
  test("无机场城市会映射到可用机场码", () => {
    assert.equal(flightCityCode("苏州"), "WUX");
    assert.equal(flightCityCode("苏州市"), "WUX");
    assert.equal(flightCityCode("昆山"), "SHA");
    assert.equal(flightCityCode("PEK"), "PEK");
  });

  test("高德配置检查不泄露 Key", async () => {
    const j = await asJson(await GET("/api/amap/config", userToken));
    assert.equal(typeof j.enabled, "boolean");
    assert.equal("key" in j, false);
  });

  test("路径规划非法坐标返回 400", async () => {
    const res = await GET("/api/amap/route?origin=abc&destination=120,30", userToken);
    assert.equal(res.status, 400);
  });

  test("城际交通缺参数返回 400", async () => {
    assert.equal((await GET("/api/transport", userToken)).status, 400);
  });

  test("POI 搜索参数校验", async () => {
    assert.equal((await GET("/api/poi/search", userToken)).status, 400);
    assert.equal((await GET("/api/poi/search?q=机场&source=local", userToken)).status, 400);
  });

  test("管理员可读取运行记录（本地文件后端下也不报错）", async () => {
    const runs = await asJson(await GET("/api/runs?limit=5", adminToken));
    assert.equal(typeof runs.dbReady, "boolean");
    assert.ok(Array.isArray(runs.runs));
    const adminRuns = await asJson(await GET("/api/admin/runs?limit=5", adminToken));
    assert.ok(Array.isArray(adminRuns.runs));
  });

  test("/api/run 参数校验：空城市 400、本地模式未覆盖城市 422", async () => {
    assert.equal((await POST("/api/run", { city: "" }, userToken)).status, 400);
    assert.equal((await POST("/api/run", { city: "北京", source: "local" }, userToken)).status, 422);
  });

  test("CORS 预检允许 PUT（个人信息保存的跨源调用）", async () => {
    const res = await call("OPTIONS", "/api/profile", {
      headers: {
        Origin: "http://localhost:5173",
        "Access-Control-Request-Method": "PUT",
      },
    });
    const allow = res.headers.get("access-control-allow-methods") ?? "";
    assert.match(allow, /PUT/, `预检响应需允许 PUT，实际：${allow}`);
  });

  test("SPA 回退：/s/:slug 返回前端页面", async () => {
    const res = await GET(`/s/${createdSlug || "demo1234"}`);
    assert.equal(res.status, 200);
    const type = res.headers.get("content-type") ?? "";
    assert.match(type, /html/i);
  });
});
