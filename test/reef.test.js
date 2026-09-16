import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRig, ValidationError } from "../src/domain.js";
import { decide, normalizeLevels } from "../src/reef.js";
import { evaluate } from "../src/physics.js";
import { validRigInput } from "./helpers.js";

const rig = validateRig(validRigInput());

function product(r) {
  const out = [];
  const counts = r.sails.map((s) => s.reefs.length);
  const rec = (i, acc) => {
    if (i === counts.length) { out.push(acc.slice()); return; }
    for (let l = 0; l < counts[i]; l++) { acc.push(l); rec(i + 1, acc); acc.pop(); }
  };
  rec(0, []);
  return out;
}
function toLevels(r, tuple) {
  const lv = {};
  r.sails.forEach((s, i) => { lv[s.id] = tuple[i]; });
  return lv;
}

test("低风级：safe，无需缩帆", () => {
  const d = decide(rig, { beaufort: 2, direction: 90 }, {});
  assert.equal(d.status, "safe");
  assert.equal(d.feasible, true);
  assert.equal(d.solution, null);
  assert.ok(d.current.maxSafeBeaufort >= 2);
  assert.match(d.nextStep, /保持现档位/);
});

test("feasible 与安全状态一致：safe/reef_required 为 true，infeasible 为 false", () => {
  const weak = validateRig(validRigInput({
    code: "F",
    displacement: 6000,
    rightingCurve: [{ heel: 0, arm: 0 }, { heel: 10, arm: 0.03 }, { heel: 20, arm: 0.02 },
      { heel: 30, arm: 0.01 }, { heel: 40, arm: 0 }, { heel: 60, arm: -0.02 }, { heel: 90, arm: -0.05 }],
  }));
  assert.equal(decide(rig, { beaufort: 1, direction: 90 }, {}).feasible, true);
  assert.equal(decide(rig, { beaufort: 7, direction: 90 }, {}).status, "reef_required");
  assert.equal(decide(rig, { beaufort: 7, direction: 90 }, {}).feasible, true);
  assert.equal(decide(weak, { beaufort: 12, direction: 90 }, {}).feasible, false);
  assert.equal(decide(rig, { beaufort: 12, direction: 0 }, {}).feasible, true);
});

test("风级升高：reef_required，方案逐级可达且最小", () => {
  let firstUnsafe = -1;
  for (let b = 0; b <= 12; b++) {
    if (!decide(rig, { beaufort: b, direction: 90 }, {}).current.evaluation.safe) { firstUnsafe = b; break; }
  }
  assert.ok(firstUnsafe > 0);
  const d = decide(rig, { beaufort: firstUnsafe, direction: 90 }, {});
  assert.equal(d.status, "reef_required");
  assert.ok(d.solution);
  for (const m of d.solution.firstMoves) {
    assert.equal(m.to, m.from + 1);
    assert.ok(m.depth >= 1);
  }
  assert.ok(d.solution.maxSafeBeaufort >= firstUnsafe);
  // 最小性：枚举所有更少档距的组合，必须全部不安全
  let saferExists = false;
  for (const tuple of product(rig)) {
    const inc = tuple.reduce((a, b) => a + b, 0);
    if (inc < d.solution.increments && evaluate(rig, toLevels(rig, tuple), firstUnsafe, 90).safe) {
      saferExists = true;
    }
  }
  assert.equal(saferExists, false, "存在档距更少的安全方案，最小缩帆判定错误");
});

test("方案档距数 = 各帆档差之和；firstMoves 只含需要收的帆", () => {
  const d = decide(rig, { beaufort: 11, direction: 90 }, {});
  if (d.solution) {
    const sum = rig.sails.reduce((n, s) => n + d.solution.levels[s.id], 0);
    assert.equal(d.solution.increments, sum);
    for (const m of d.solution.firstMoves) {
      assert.equal(m.from, 0);
      assert.equal(m.depth, d.solution.levels[m.sailId]);
    }
  }
});

test("已有档位：方案只允许继续加深，不允许通过决策偷偷放帆", () => {
  const d = decide(rig, { beaufort: 8, direction: 90 }, { a: 2, b: 2 });
  if (d.solution) {
    assert.ok(d.solution.levels.a >= 2);
    assert.ok(d.solution.levels.b >= 2);
  }
});

test("无解：弱船高风级 infeasible，原因与下一步明确", () => {
  const weak = validateRig(validRigInput({
    code: "WEAK",
    displacement: 6000,
    rightingCurve: [{ heel: 0, arm: 0 }, { heel: 10, arm: 0.03 }, { heel: 20, arm: 0.02 },
      { heel: 30, arm: 0.01 }, { heel: 40, arm: 0 }, { heel: 60, arm: -0.02 }, { heel: 90, arm: -0.05 }],
  }));
  const d = decide(weak, { beaufort: 10, direction: 90 }, {});
  assert.equal(d.status, "infeasible");
  assert.equal(d.feasible, false);
  assert.equal(d.solution, null);
  assert.match(d.reason, /最深档/);
  assert.ok(d.nextStep.length > 5);
});

test("纵向无解：最深档仍超出 xRange，建议调压载而非继续收帆", () => {
  const trim = validateRig(validRigInput({
    code: "TRIM",
    limits: { dangerHeel: 40, xRange: [-1, 1], safetyFactor: 1.5 },
  }));
  const d = decide(trim, { beaufort: 3, direction: 90 }, {});
  assert.equal(d.status, "infeasible");
  assert.ok(d.reason.includes("纵向") || d.deepest.evaluation.reasons.some((r) => r.includes("纵向")));
  assert.match(d.nextStep, /压载|纵向|航向/);
});

test("顶风：任何风级都安全（无横向受风）", () => {
  const d = decide(rig, { beaufort: 12, direction: 0 }, {});
  assert.equal(d.status, "safe");
});

test("normalizeLevels 拒绝不存在的档位", () => {
  assert.throws(() => normalizeLevels(rig, { a: 9 }), ValidationError);
  assert.deepEqual(normalizeLevels(rig, {}), { a: 0, b: 0 });
});
