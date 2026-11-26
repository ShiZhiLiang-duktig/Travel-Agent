/**
 * 本地草稿持久化回归测试 —— 「刷新后偏好清空、城市/日期保留」。
 *
 * 用内存 localStorage 模拟浏览器：保存 → 刷新（重新 load），
 * 覆盖偏好不落盘、旧版草稿迁移清理、脏数据收敛、清空、收藏往返。
 * 不依赖浏览器 / 网络 / 服务端。
 */
import { describe, test, before } from "node:test";
import assert from "node:assert/strict";

let storage: typeof import("../web/src/storage.ts");
let defaultPreferences: typeof import("../web/src/api.ts").defaultPreferences;
let mem: Map<string, string>;

const SESSION_KEY = "tw_session_v1";
const FAV_KEY = "tw_favorite_pois_v1";

function session() {
  return {
    view: "ai" as const,
    cities: ["阳泉"],
    startDate: "2026-12-01",
    endDate: "2026-12-03",
    manualStops: [],
  };
}

function chosenPrefs() {
  return {
    ...defaultPreferences,
    budget: 5000,
    pace: "tight",
    group: ["青年", "朋友"],
    must_visit: ["娘子关景区-关庙", "阳泉记忆·1947文化园"],
    avoid: ["高台阶", "纯室外"],
    afternoon_indoor: true,
    must_have_lunch: true,
  };
}

before(async () => {
  mem = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    get length() { return mem.size; },
  };
  storage = await import("../web/src/storage.ts");
  defaultPreferences = (await import("../web/src/api.ts")).defaultPreferences;
});

describe("旅行偏好刷新即清空", () => {
  test("首次使用：空存储返回 null", () => {
    mem.clear();
    assert.equal(storage.loadSession(), null);
  });

  test("刷新后偏好不会恢复：草稿里没有 prefs / extra", () => {
    mem.clear();
    storage.saveSession(session());

    // 模拟刷新：组件重新挂载，只从 localStorage 读
    const r = storage.loadSession();
    assert.ok(r, "应能恢复城市 / 日期草稿");
    assert.equal("prefs" in r, false, "偏好不得写进草稿");
    assert.equal("extra" in r, false, "补充描述不得写进草稿");
    // 兜底：即使有人手工把 prefs 塞回去，也读不出来
    assert.equal((r as any).prefs, undefined);
  });

  test("城市 / 日期 / 视图 / 手动选点仍正常恢复", () => {
    mem.clear();
    storage.saveSession({
      ...session(),
      view: "manual",
      cities: ["苏州", "杭州"],
      manualStops: [{ name: "拙政园", lng: 120.6, lat: 31.3 } as any],
    });
    const r = storage.loadSession()!;
    assert.equal(r.view, "manual");
    assert.deepEqual(r.cities, ["苏州", "杭州"]);
    assert.equal(r.startDate, "2026-12-01");
    assert.equal(r.endDate, "2026-12-03");
    assert.equal(r.manualStops.length, 1);
    assert.equal(r.manualStops[0].name, "拙政园");
  });

  test("旧版草稿：残留的选择被清除，不再复现到界面上", () => {
    mem.clear();
    // 旧版本真实写入过的结构（带 prefs / extra）
    mem.set(SESSION_KEY, JSON.stringify({
      view: "ai",
      cities: ["阳泉"],
      startDate: "2026-12-01",
      endDate: "2026-12-03",
      prefs: chosenPrefs(),
      extra: "第一天想先去博物馆",
      manualStops: [],
    }));

    const r = storage.loadSession()!;
    assert.equal("prefs" in r, false);
    assert.equal("extra" in r, false);

    // 迁移：存储本身也被重写，历史选择不会再留在 localStorage 里
    const raw = JSON.parse(mem.get(SESSION_KEY)!);
    assert.equal("prefs" in raw, false);
    assert.equal("extra" in raw, false);
    assert.deepEqual(raw.cities, ["阳泉"]);
  });

  test("损坏的 JSON 不会崩溃，按空草稿处理", () => {
    mem.clear();
    mem.set(SESSION_KEY, "{not-json");
    assert.equal(storage.loadSession(), null);
  });

  test("旧版/残缺数据：字段类型错误被收敛", () => {
    mem.clear();
    mem.set(SESSION_KEY, JSON.stringify({
      view: "unknown",
      cities: ["苏州", 123, null],
      startDate: 20261201,
      endDate: null,
      manualStops: "不是数组",
    }));
    const r = storage.loadSession()!;
    assert.equal(r.view, "ai");
    assert.deepEqual(r.cities, ["苏州"]);
    assert.equal(r.startDate, "");
    assert.equal(r.endDate, "");
    assert.deepEqual(r.manualStops, []);
  });

  test("「清空」会删除草稿，刷新不再恢复", () => {
    mem.clear();
    storage.saveSession(session());
    assert.ok(storage.loadSession());
    storage.clearSession();
    assert.equal(storage.loadSession(), null);
    assert.equal(mem.has(SESSION_KEY), false);
  });

  test("默认偏好：人群「青年」、节奏「适中」，其余为未选（刷新后的起点）", () => {
    assert.deepEqual(defaultPreferences.group, ["青年"]);
    assert.equal(defaultPreferences.pace, "moderate");
    assert.deepEqual(defaultPreferences.must_visit, []);
    assert.deepEqual(defaultPreferences.avoid, []);
    assert.equal(defaultPreferences.afternoon_indoor, false);
    assert.equal(defaultPreferences.must_have_lunch, false);
  });

  test("POI 收藏往返 + 脏数据过滤（收藏不受本次改动影响）", () => {
    mem.clear();
    assert.deepEqual(storage.loadFavorites(), []);
    storage.saveFavorites(["p1", "p2"]);
    assert.deepEqual(storage.loadFavorites(), ["p1", "p2"]);
    mem.set(FAV_KEY, JSON.stringify(["p1", 7, null, "p3"]));
    assert.deepEqual(storage.loadFavorites(), ["p1", "p3"]);
  });
});
