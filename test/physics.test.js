import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRig } from "../src/domain.js";
import {
  windPressure, windComponents, forceCenter, evaluate, gzAt, GUST_FACTOR,
} from "../src/physics.js";
import { validRigInput } from "./helpers.js";

const rig = validateRig(validRigInput());

test("风压随风级单调上升，含阵风系数", () => {
  const p0 = windPressure(0);
  const p6 = windPressure(6);
  assert.equal(p0, 0);
  assert.ok(p6 > 100);
  assert.ok(windPressure(12) > p6);
  // 显式：0.5*ρ*(v*gust)^2
  assert.ok(Math.abs(p6 - 0.5 * 1.225 * Math.pow(10.8 * GUST_FACTOR, 2)) < 1e-6);
});

test("风向分量：顶风无横倾分量，横风最大", () => {
  assert.ok(Math.abs(windComponents(0).beam) < 1e-9);
  assert.ok(Math.abs(windComponents(180).beam) < 1e-9);
  assert.ok(Math.abs(windComponents(90).beam - 1) < 1e-9);
  assert.ok(windComponents(45).beam > 0.7 && windComponents(45).beam < 0.71);
});

test("GZ 线性插值与越界返回 null", () => {
  assert.ok(Math.abs(gzAt(rig.rightingCurve, 5) - 0.45 / 2) < 1e-9);
  assert.equal(gzAt(rig.rightingCurve, 95), null);
});

test("合力中心按面积加权；缩帆后面积减小、形心下降", () => {
  const full = forceCenter(rig, { a: 0, b: 0 }, 90);
  const reefed = forceCenter(rig, { a: 2, b: 2 }, 90);
  assert.ok(reefed.area < full.area);
  assert.ok(reefed.z < full.z);
  // 满帆加权 x = (40*6+60*0)/100
  assert.ok(Math.abs(full.x - 2.4) < 1e-9);
  // 顶风横风投影面积为 0
  assert.equal(forceCenter(rig, { a: 0, b: 0 }, 0).areaProjected, 0);
});

test("评估：低风级安全、风级升高转不安全且给出原因", () => {
  const calm = evaluate(rig, { a: 0, b: 0 }, 1, 90);
  const strong = evaluate(rig, { a: 0, b: 0 }, 9, 90);
  assert.equal(calm.safe, true);
  assert.equal(strong.safe, false);
  assert.ok(strong.reasons.length > 0);
  assert.ok(strong.moment.windHeel > calm.moment.windHeel);
});

test("顶风在任何风级都无横倾力矩（受风为零）", () => {
  const e = evaluate(rig, { a: 0, b: 0 }, 12, 0);
  assert.equal(e.moment.windHeel, 0);
  assert.equal(e.heel.equilibrium, 0);
});

test("纵向失衡：合力中心超出 xRange 即不安全，与风级无关", () => {
  const trimBad = validateRig(validRigInput({
    sails: [
      {
        id: "a", name: "巨前帆", area: 90, centroid: { x: 9, z: 10 },
        reefs: [
          { level: 0, areaFactor: 1 },
          { level: 1, areaFactor: 0.5, centroidShift: { x: -1, z: -1 } },
        ],
      },
      {
        id: "b", name: "小尾帆", area: 10, centroid: { x: -8, z: 7 },
        reefs: [{ level: 0, areaFactor: 1 }],
      },
    ],
  }));
  const e = evaluate(trimBad, { a: 0, b: 0 }, 2, 90);
  assert.equal(e.longitudinal.within, false);
  assert.ok(e.reasons.some((r) => r.includes("纵向")));
});

test("危险倾角：若到危险角仍未平衡，equilibrium 为 null 且标记 reachesDanger", () => {
  // 用极弱复原力 + 强风
  const weak = validateRig(validRigInput({
    displacement: 8000,
    rightingCurve: [{ heel: 0, arm: 0 }, { heel: 10, arm: 0.03 }, { heel: 40, arm: 0.01 }, { heel: 60, arm: 0 }],
  }));
  const e = evaluate(weak, { a: 0, b: 0 }, 10, 90);
  assert.equal(e.safe, false);
  assert.equal(e.heel.equilibrium, null);
  assert.equal(e.heel.reachesDanger, true);
});
