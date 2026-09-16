import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ValidationError, validateRig, validateMoves, validateWind,
} from "../src/domain.js";
import { validRigInput } from "./helpers.js";

function expectCodes(fn, codes) {
  try {
    fn();
    assert.fail("应当抛出 ValidationError");
  } catch (e) {
    assert.ok(e instanceof ValidationError, "应为 ValidationError，实际：" + e.constructor.name);
    const got = e.errors.map((x) => x.code);
    for (const c of codes) assert.ok(got.includes(c), `应包含错误码 ${c}，实际 ${got.join(",")}`);
    return e.errors;
  }
}

test("合法帆装通过校验并规范化", () => {
  const rig = validateRig(validRigInput());
  assert.equal(rig.sails.length, 2);
  assert.equal(rig.sails[0].reefs[0].areaFactor, 1);
  assert.deepEqual(rig.limits.xRange, [-6, 6]);
});

test("数据缺失：无风级/无风向", () => {
  expectCodes(() => validateWind({}), ["WIND_MISSING"]);
  expectCodes(() => validateWind({ beaufort: 13 }), ["WIND_BEAUFORT_INVALID"]);
  expectCodes(() => validateWind({ beaufort: 1.5 }), ["WIND_BEAUFORT_INVALID"]);
});

test("数据缺失：无帆、无面积、无形心、无排水量", () => {
  expectCodes(() => validateRig(validRigInput({ displacement: 0 })), ["RIG_DISPLACEMENT_MISSING"]);
  expectCodes(() => validateRig(validRigInput({ sails: [] })), ["RIG_SAILS_MISSING"]);
  const bad = validRigInput();
  delete bad.sails[0].centroid.z;
  bad.sails[0].area = -1;
  expectCodes(() => validateRig(bad), ["SAIL_AREA_MISSING", "SAIL_CENTROID_MISSING"]);
});

test("曲线乱序 / 未从 0 开始 / 覆盖不足 全部拒绝", () => {
  expectCodes(() => validateRig(validRigInput({
    rightingCurve: [{ heel: 0, arm: 0.2 }, { heel: 30, arm: 0.4 }, { heel: 20, arm: 0.3 }, { heel: 40, arm: 0.1 }],
  })), ["CURVE_UNORDERED"]);
  expectCodes(() => validateRig(validRigInput({
    rightingCurve: [{ heel: 5, arm: 0.2 }, { heel: 40, arm: 0.1 }],
  })), ["CURVE_UNORDERED"]);
  expectCodes(() => validateRig(validRigInput({
    rightingCurve: [{ heel: 0, arm: 0 }, { heel: 20, arm: 0.3 }], // 未达危险角 40
  })), ["CURVE_RANGE"]);
  expectCodes(() => validateRig(validRigInput({ rightingCurve: [{ heel: 0, arm: 0.2 }] })), ["CURVE_MISSING"]);
  // GZ 曲线必须过原点
  expectCodes(() => validateRig(validRigInput({
    rightingCurve: [{ heel: 0, arm: 0.2 }, { heel: 10, arm: 0.3 }, { heel: 40, arm: 0.1 }, { heel: 60, arm: 0 }],
  })), ["CURVE_ORIGIN"]);
});

test("重复档与跳档（非 0,1,2 连续）拒绝", () => {
  const dup = validRigInput();
  dup.sails[0].reefs.push({ level: 1, areaFactor: 0.2 });
  expectCodes(() => validateRig(dup), ["REEF_DUPLICATE"]);
  const gap = validRigInput();
  gap.sails[0].reefs = [{ level: 0, areaFactor: 1 }, { level: 2, areaFactor: 0.3 }]; // 缺 1 档
  expectCodes(() => validateRig(gap), ["REEF_GAP"]);
  const noZero = validRigInput();
  noZero.sails[0].reefs = [{ level: 1, areaFactor: 1 }, { level: 2, areaFactor: 0.3 }];
  expectCodes(() => validateRig(noZero), ["REEF_GAP"]);
});

test("面积系数非法（0 档非满帆、缩帆后增大）拒绝", () => {
  const bad0 = validRigInput();
  bad0.sails[0].reefs[0].areaFactor = 0.9;
  expectCodes(() => validateRig(bad0), ["REEF_FACTOR_INVALID"]);
  const grow = validRigInput();
  grow.sails[0].reefs[1].areaFactor = 1; // 一档比满帆还大
  expectCodes(() => validateRig(grow), ["REEF_FACTOR_INVALID"]);
});

test("限制参数非法拒绝", () => {
  expectCodes(() => validateRig(validRigInput({ limits: { dangerHeel: 200, xRange: [-1, 1], safetyFactor: 1.5 } })), ["LIMIT_DANGER_INVALID"]);
  expectCodes(() => validateRig(validRigInput({ limits: { dangerHeel: 40, xRange: [2, 1], safetyFactor: 1.5 } })), ["LIMIT_XRANGE_INVALID"]);
  expectCodes(() => validateRig(validRigInput({ limits: { dangerHeel: 40, xRange: [-1, 1], safetyFactor: 0.8 } })), ["LIMIT_FACTOR_INVALID"]);
});

test("逐级调整：跳两档拒绝、单步放行、同帆重复拒绝", () => {
  const rig = validateRig(validRigInput());
  expectCodes(() => validateMoves(rig, { a: 0, b: 0 }, [{ sailId: "a", toLevel: 2 }]), ["REEF_JUMP_ILLEGAL"]);
  expectCodes(() => validateMoves(rig, { a: 0, b: 0 }, []), ["MOVE_MISSING"]);
  expectCodes(() => validateMoves(rig, { a: 0, b: 0 }, [
    { sailId: "a", toLevel: 1 }, { sailId: "a", toLevel: 1 },
  ]), ["MOVE_DUPLICATE"]);
  expectCodes(() => validateMoves(rig, { a: 0, b: 0 }, [{ sailId: "zzz", toLevel: 1 }]), ["SAIL_NOT_FOUND"]);
  // 合法单步（含放帆 2->1）
  assert.doesNotThrow(() => validateMoves(rig, { a: 2, b: 0 }, [{ sailId: "a", toLevel: 1 }]));
  assert.doesNotThrow(() => validateMoves(rig, { a: 0, b: 0 }, [{ sailId: "a", toLevel: 1 }, { sailId: "b", toLevel: 1 }]));
});
