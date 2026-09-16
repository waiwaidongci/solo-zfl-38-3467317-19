import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ValidationError, validateRig, validateMoves, validateWind, migrateLevels,
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

test("档位迁移 clamp：减少档数时越界档钳到末档", () => {
  const oldRig = validateRig(validRigInput()); // a,b 各 3 档（0..2）
  const fewer = validateRig(validRigInput({
    sails: [
      { id: "a", name: "前帆", area: 40, centroid: { x: 6, z: 9 }, reefs: [{ level: 0, areaFactor: 1 }, { level: 1, areaFactor: 0.6 }] },
      { id: "b", name: "主帆", area: 60, centroid: { x: 0, z: 12 }, reefs: [
        { level: 0, areaFactor: 1 }, { level: 1, areaFactor: 0.65, centroidShift: { z: -1 } }, { level: 2, areaFactor: 0.3, centroidShift: { z: -2 } },
      ] },
    ],
  }));
  const old = { ...oldRig, currentLevels: { a: 2, b: 1 } };
  const { levels, migrations } = migrateLevels(old, fewer, "clamp");
  assert.deepEqual(levels, { a: 1, b: 1 });
  const m = migrations.find((x) => x.sailId === "a");
  assert.equal(m.action, "clamped");
  assert.equal(m.from, 2);
  assert.equal(m.to, 1);
  // 迁移后所有档位都在新定义内，可直接用于逐级作业
  assert.doesNotThrow(() => validateMoves(fewer, levels, [{ sailId: "a", toLevel: 0 }]));
});

test("档位迁移 clamp：复用帆面编号按新档数钳制，不视为新帆", () => {
  const oldRig = validateRig(validRigInput());
  const reused = validateRig(validRigInput({
    sails: [
      { id: "a", name: "另一面前帆", area: 20, centroid: { x: 5, z: 8 }, reefs: [{ level: 0, areaFactor: 1 }, { level: 1, areaFactor: 0.5 }] },
      { id: "b", name: "主帆", area: 60, centroid: { x: 0, z: 12 }, reefs: [
        { level: 0, areaFactor: 1 }, { level: 1, areaFactor: 0.65, centroidShift: { z: -1 } }, { level: 2, areaFactor: 0.3, centroidShift: { z: -2 } },
      ] },
    ],
  }));
  const { levels, migrations } = migrateLevels({ ...oldRig, currentLevels: { a: 2, b: 0 } }, reused, "clamp");
  assert.equal(levels.a, 1);
  assert.equal(migrations.some((m) => m.sailId === "a" && m.action === "added"), false);
  assert.ok(migrations.some((m) => m.sailId === "a" && m.action === "clamped"));
});

test("档位迁移 clamp：移除帆删档、新增帆初始 0 档", () => {
  const oldRig = validateRig(validRigInput());
  const onlyA = validateRig(validRigInput({
    sails: [
      oldRig.sails[0],
      {
        id: "c", name: "新帆", area: 15, centroid: { x: 3, z: 7 },
        reefs: [{ level: 0, areaFactor: 1 }, { level: 1, areaFactor: 0.4 }],
      },
    ],
  }));
  const { levels, migrations } = migrateLevels(
    { ...oldRig, currentLevels: { a: 1, b: 0 } }, onlyA, "clamp"
  );
  assert.deepEqual(levels, { a: 1, c: 0 });
  assert.deepEqual(migrations.map((m) => m.sailId + ":" + m.action).sort(), ["b:removed", "c:added"]);
});

test("档位迁移 reject：越界档或移除收帆中的帆整体拒绝", () => {
  const oldRig = validateRig(validRigInput());
  const fewer = validateRig(validRigInput({
    sails: [
      { id: "a", name: "前帆", area: 40, centroid: { x: 6, z: 9 }, reefs: [{ level: 0, areaFactor: 1 }] },
      oldRig.sails[1],
    ],
  }));
  expectCodes(() => migrateLevels({ ...oldRig, currentLevels: { a: 2, b: 0 } }, fewer, "reject"), ["LEVEL_OUT_OF_RANGE"]);
  const noA = validateRig(validRigInput({ sails: [oldRig.sails[1]] }));
  expectCodes(() => migrateLevels({ ...oldRig, currentLevels: { a: 1, b: 0 } }, noA, "reject"), ["LEVEL_SAIL_REMOVED"]);
});

test("档位迁移：无冲突时两种策略都不产生迁移记录", () => {
  const rig = validateRig(validRigInput());
  for (const policy of ["clamp", "reject"]) {
    const { levels, migrations } = migrateLevels({ ...rig, currentLevels: { a: 1, b: 0 } }, rig, policy);
    assert.deepEqual(levels, { a: 1, b: 0 });
    assert.deepEqual(migrations, []);
  }
  expectCodes(() => migrateLevels({}, rig, "bogus"), ["LEVEL_POLICY_INVALID"]);
});
