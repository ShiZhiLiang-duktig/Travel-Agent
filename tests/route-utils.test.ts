/**
 * 手动路线费用回归：即使旧草稿或搜索结果里 cost=0 / 缺失，
 * 也必须从 POI 目录补齐单价，并按同行人数汇总到行程预算。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildManualItinerary,
  resolveManualStopCost,
} from "../web/src/route-utils.js";
import type { ManualStop, PoiSnapshot } from "../web/src/api.js";

const catalog: PoiSnapshot[] = [
  {
    id: "s1",
    name: "拙政园",
    city: "苏州",
    category: "景点",
    lat: 31.324,
    lng: 120.628,
    price_per_person: 80,
  },
  {
    id: "sr1",
    name: "松鹤楼",
    city: "苏州",
    category: "餐厅",
    lat: 31.32,
    lng: 120.628,
    price_per_person: 120,
  },
];

function stop(id: string, name: string, order: number): ManualStop {
  return {
    id,
    name,
    day: 1,
    order,
    lat: 31.32,
    lng: 120.62,
    category: id === "sr1" ? "餐厅" : "景点",
    cost: 0,
    walking_minutes: 10,
    visit_minutes: 60,
  };
}

describe("手动路线费用", () => {
  test("cost=0 时从 POI 目录补齐单价", () => {
    assert.equal(resolveManualStopCost(stop("s1", "拙政园", 0), catalog), 80);
  });

  test("应用为行程后总费用不为 0，并按同行人数汇总", () => {
    const itinerary = buildManualItinerary(
      [stop("s1", "拙政园", 0), stop("sr1", "松鹤楼", 1)],
      "苏州",
      1,
      { travelers: 3, pois: catalog },
    );
    assert.equal(itinerary.items.length, 2);
    assert.deepEqual(
      itinerary.items.map((item) => item.cost),
      [240, 360],
    );
    assert.equal(itinerary.total_cost, 600);
    assert.ok(itinerary.total_cost > 0);
  });

  test("已保存的有效单价优先于目录值", () => {
    const withPrice = { ...stop("s1", "拙政园", 0), cost: 55 };
    assert.equal(resolveManualStopCost(withPrice, catalog), 55);
  });
});
