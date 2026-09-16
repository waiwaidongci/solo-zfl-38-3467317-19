import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tempDbFile, cleanup, startServer, api, validRigInput } from "./helpers.js";

async function server(label) {
  const { file, dir } = await tempDbFile(label);
  after(() => cleanup(dir));
  return startServer(file);
}

test("健康检查与船只列表", async () => {
  const s = await server("health");
  after(s.stop);
  const h = await fetch(s.base + "/health").then((r) => r.json());
  assert.equal(h.ok, true);
  const { status, data } = await api(s.base, "/api/rigs");
  assert.equal(status, 200);
  assert.ok(data.rigs.some((r) => r.code === "FC-001"));
});

test("决策接口：FC-001 低风级安全、高风级给出缩帆方案", async () => {
  const s = await server("decision");
  after(s.stop);
  const calm = await api(s.base, "/api/rigs/FC-001/decision?beaufort=3&direction=90");
  assert.equal(calm.status, 200);
  assert.equal(calm.data.decision.status, "safe");
  const strong = await api(s.base, "/api/rigs/FC-001/decision?beaufort=9&direction=90");
  assert.equal(strong.data.decision.status, "reef_required");
  assert.equal(strong.data.version, 1);
  assert.ok(strong.data.decision.solution.firstMoves.length >= 1);
  for (const m of strong.data.decision.solution.firstMoves) assert.equal(m.to, m.from + 1);
});

test("无解路径：SD-002 在 8 级横风 infeasible", async () => {
  const s = await server("infeasible");
  after(s.stop);
  const { status, data } = await api(s.base, "/api/rigs/SD-002/decision?beaufort=8&direction=90");
  assert.equal(status, 200);
  assert.equal(data.decision.status, "infeasible");
  assert.equal(data.decision.solution, null);
  assert.match(data.decision.nextStep, /避风|航向|压载/);
});

test("降档路径：合法单步成功并抬升版本，决策随档位更新", async () => {
  const s = await server("reefdown");
  after(s.stop);
  const r1 = await api(s.base, "/api/rigs/FC-001/reef", {
    method: "POST",
    body: { moves: [{ sailId: "main", toLevel: 1 }], expectedVersion: 1, beaufort: 9, direction: 90 },
  });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.rig.version, 2);
  assert.equal(r1.data.rig.currentLevels.main, 1);
  assert.ok(r1.data.decision);
  // 再合法一步
  const r2 = await api(s.base, "/api/rigs/FC-001/reef", {
    method: "POST",
    body: { moves: [{ sailId: "main", toLevel: 2 }], expectedVersion: 2, beaufort: 9, direction: 90 },
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.rig.version, 3);
});

test("非法跳档被拒绝（422）且不产生写入", async () => {
  const s = await server("jump");
  after(s.stop);
  const r = await api(s.base, "/api/rigs/FC-001/reef", {
    method: "POST",
    body: { moves: [{ sailId: "main", toLevel: 3 }], expectedVersion: 1 },
  });
  assert.equal(r.status, 422);
  assert.ok(r.data.details.some((d) => d.code === "REEF_JUMP_ILLEGAL"));
  // 版本未变
  const rig = await api(s.base, "/api/rigs/FC-001");
  assert.equal(rig.data.rig.version, 1);
  assert.equal(rig.data.rig.currentLevels.main, 0);
});

test("冲突路径：两客户端同版本并发作业，后写 409 且数据只变一次", async () => {
  const s = await server("conflict");
  after(s.stop);
  const [r1, r2] = await Promise.all([
    api(s.base, "/api/rigs/FC-001/reef", { method: "POST", body: { moves: [{ sailId: "main", toLevel: 1 }], expectedVersion: 1 } }),
    api(s.base, "/api/rigs/FC-001/reef", { method: "POST", body: { moves: [{ sailId: "fore", toLevel: 1 }], expectedVersion: 1 } }),
  ]);
  const ok = [r1, r2].filter((r) => r.status === 200);
  const conflict = [r1, r2].find((r) => r.status === 409);
  assert.equal(ok.length, 1);
  assert.equal(conflict.data.error, "VERSION_CONFLICT");
  assert.equal(conflict.data.currentVersion, 2);
  const rig = await api(s.base, "/api/rigs/FC-001");
  assert.equal(rig.data.rig.version, 2);
  // 只一面帆被收
  const changed = Object.entries(rig.data.rig.currentLevels).filter(([, v]) => v === 1);
  assert.equal(changed.length, 1);
});

test("过期版本更新登记 409；正确版本更新成功", async () => {
  const s = await server("stale");
  after(s.stop);
  const body = validRigInput({ code: "FC-001", name: "改过名的福船" });
  const stale = await api(s.base, "/api/rigs/FC-001", { method: "PUT", body: { ...body, expectedVersion: 5 } });
  assert.equal(stale.status, 409);
  const ok = await api(s.base, "/api/rigs/FC-001", { method: "PUT", body: { ...body, expectedVersion: 1 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.rig.version, 2);
  assert.equal(ok.data.rig.name, "改过名的福船");
  // 帆面定义整体替换：旧 fore/main/mizzen 移除（0 档，记录但不告警），新 a/b 初始化为 0 档
  assert.deepEqual(ok.data.rig.currentLevels, { a: 0, b: 0 });
  const actions = ok.data.migrations.map((m) => m.sailId + ":" + m.action).sort();
  assert.deepEqual(actions, ["a:added", "b:added", "fore:removed", "main:removed", "mizzen:removed"]);
});

test("登记校验：缺数据、曲线乱序、重复档分别 422", async () => {
  const s = await server("validate");
  after(s.stop);
  const missing = await api(s.base, "/api/rigs", { method: "POST", body: { code: "BAD" } });
  assert.equal(missing.status, 422);
  assert.ok(missing.data.details.some((d) => d.code === "RIG_DISPLACEMENT_MISSING"));

  const unordered = validRigInput({ code: "BAD-2" });
  unordered.rightingCurve[2].heel = 5; // 乱序
  const r2 = await api(s.base, "/api/rigs", { method: "POST", body: unordered });
  assert.equal(r2.status, 422);
  assert.ok(r2.data.details.some((d) => d.code === "CURVE_UNORDERED"));

  const dup = validRigInput({ code: "BAD-3" });
  dup.sails[0].reefs.push({ level: 1, areaFactor: 0.2 });
  const r3 = await api(s.base, "/api/rigs", { method: "POST", body: dup });
  assert.equal(r3.status, 422);
  assert.ok(r3.data.details.some((d) => d.code === "REEF_DUPLICATE"));
});

test("风级/风向非法 422", async () => {
  const s = await server("wind");
  after(s.stop);
  assert.equal((await api(s.base, "/api/rigs/FC-001/decision?beaufort=99&direction=90")).status, 422);
  assert.equal((await api(s.base, "/api/rigs/FC-001/decision?beaufort=6")).status, 422);
});

test("未知船只 404；非法 JSON 422", async () => {
  const s = await server("nf");
  after(s.stop);
  assert.equal((await api(s.base, "/api/rigs/NOPE")).status, 404);
  const res = await fetch(s.base + "/api/rigs", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops",
  });
  assert.equal(res.status, 422);
});

test("旧版台账接口仍可用", async () => {
  const s = await server("legacy");
  after(s.stop);
  const created = await api(s.base, "/api/items", { method: "POST", body: { code: "MR-X", shipType: "鸟船", status: "待检查" } });
  assert.equal(created.status, 201);
  const list = await api(s.base, "/api/items");
  assert.ok(list.data.some((i) => i.code === "MR-X"));
});

test("更新减档：clamp 钳制越界档位并留痕，reject 整体 422 不落盘", async () => {
  const s = await server("update-levels");
  after(s.stop);
  const baseBody = validRigInput({ code: "UP-1" });
  const created = await api(s.base, "/api/rigs", { method: "POST", body: baseBody });
  assert.equal(created.status, 201);
  // a 收至 2 档（末档）
  let r = await api(s.base, "/api/rigs/UP-1/reef", { method: "POST", body: { moves: [{ sailId: "a", toLevel: 1 }], expectedVersion: 1 } });
  assert.equal(r.status, 200);
  r = await api(s.base, "/api/rigs/UP-1/reef", { method: "POST", body: { moves: [{ sailId: "a", toLevel: 2 }], expectedVersion: 2 } });
  assert.equal(r.status, 200);

  // clamp：新定义 a 只有 0/1 两档 -> 2 钳到 1
  const fewer = validRigInput({
    code: "UP-1",
    sails: [
      { id: "a", name: "前帆", area: 40, centroid: { x: 6, z: 9 }, reefs: [
        { level: 0, areaFactor: 1 }, { level: 1, areaFactor: 0.6, centroidShift: { z: -1 } }] },
      baseBody.sails[1],
    ],
  });
  const clamped = await api(s.base, "/api/rigs/UP-1", {
    method: "PUT", body: { ...fewer, expectedVersion: 3, levelPolicy: "clamp" },
  });
  assert.equal(clamped.status, 200);
  assert.equal(clamped.data.rig.currentLevels.a, 1);
  assert.ok(clamped.data.migrations.some((m) => m.action === "clamped" && m.from === 2 && m.to === 1));
  // 更新后决策不再 422，且逐级放帆可用
  const dec = await api(s.base, "/api/rigs/UP-1/decision?beaufort=1&direction=90");
  assert.equal(dec.status, 200);
  assert.equal(dec.data.decision.feasible, true);
  const out = await api(s.base, "/api/rigs/UP-1/reef", {
    method: "POST", body: { moves: [{ sailId: "a", toLevel: 0 }], expectedVersion: 4 },
  });
  assert.equal(out.status, 200);
  assert.equal(out.data.rig.currentLevels.a, 0);

  // reject：先把 a 收至 1 档，再 PUT 成 a 只有 0 档 -> 422 且不抬版本/不落盘
  await api(s.base, "/api/rigs/UP-1/reef", { method: "POST", body: { moves: [{ sailId: "a", toLevel: 1 }], expectedVersion: 5 } });
  const onlyZero = validRigInput({
    code: "UP-1",
    sails: [
      { id: "a", name: "前帆", area: 40, centroid: { x: 6, z: 9 }, reefs: [{ level: 0, areaFactor: 1 }] },
      baseBody.sails[1],
    ],
  });
  const rejected = await api(s.base, "/api/rigs/UP-1", {
    method: "PUT", body: { ...onlyZero, expectedVersion: 6, levelPolicy: "reject" },
  });
  assert.equal(rejected.status, 422);
  assert.ok(rejected.data.details.some((d) => d.code === "LEVEL_OUT_OF_RANGE"));
  const afterReject = await api(s.base, "/api/rigs/UP-1");
  assert.equal(afterReject.data.rig.version, 6);           // 版本未变
  assert.equal(afterReject.data.rig.sails[0].reefs.length, 2); // 定义未变（仍两档）
  assert.equal(afterReject.data.rig.currentLevels.a, 1);    // 档位未变

  // 未知策略同样 422
  const badPolicy = await api(s.base, "/api/rigs/UP-1", {
    method: "PUT", body: { ...fewer, expectedVersion: 6, levelPolicy: "nope" },
  });
  assert.equal(badPolicy.status, 422);
});

test("更新移除/新增/复用帆面编号：clamp 正确迁移档位", async () => {
  const s = await server("update-sails");
  after(s.stop);
  const baseBody = validRigInput({ code: "UP-2" });
  await api(s.base, "/api/rigs", { method: "POST", body: baseBody });
  await api(s.base, "/api/rigs/UP-2/reef", { method: "POST", body: { moves: [{ sailId: "b", toLevel: 1 }], expectedVersion: 1 } });

  // 移除 b（收帆中），新增 c：clamp
  const changed = validRigInput({
    code: "UP-2",
    sails: [
      baseBody.sails[0],
      { id: "c", name: "新帆", area: 15, centroid: { x: 3, z: 7 }, reefs: [{ level: 0, areaFactor: 1 }, { level: 1, areaFactor: 0.4 }] },
    ],
  });
  const r = await api(s.base, "/api/rigs/UP-2", { method: "PUT", body: { ...changed, expectedVersion: 2 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.rig.currentLevels, { a: 0, c: 0 });
  const actions = r.data.migrations.map((m) => m.sailId + ":" + m.action).sort();
  assert.deepEqual(actions, ["b:removed", "c:added"]);

  // 复用编号 c：从 2 档船减成 1 档定义并复用 c 编号 -> clamp，不是 added
  const reused = validRigInput({
    code: "UP-2",
    sails: [
      baseBody.sails[0],
      { id: "c", name: "复用编号的新帆", area: 18, centroid: { x: 2, z: 6 }, reefs: [{ level: 0, areaFactor: 1 }] },
    ],
  });
  // c 当前 0 档，无越界，只改名不产生 clamped/added
  const r2 = await api(s.base, "/api/rigs/UP-2", { method: "PUT", body: { ...reused, expectedVersion: 3 } });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.rig.currentLevels.c, 0);
  assert.equal(r2.data.rig.sails[1].name, "复用编号的新帆");
  assert.deepEqual(r2.data.migrations, []);
});

test("合法更新（仅改曲线/名称）保持当前档位，无迁移记录", async () => {
  const s = await server("update-clean");
  after(s.stop);
  const body = validRigInput({ code: "UP-3" });
  await api(s.base, "/api/rigs", { method: "POST", body });
  await api(s.base, "/api/rigs/UP-3/reef", { method: "POST", body: { moves: [{ sailId: "a", toLevel: 1 }], expectedVersion: 1 } });
  const edited = validRigInput({
    code: "UP-3", name: "改名",
    rightingCurve: [
      { heel: 0, arm: 0 }, { heel: 10, arm: 0.4 }, { heel: 20, arm: 0.5 },
      { heel: 30, arm: 0.42 }, { heel: 40, arm: 0.25 }, { heel: 60, arm: 0.04 }, { heel: 90, arm: 0 },
    ],
  });
  const r = await api(s.base, "/api/rigs/UP-3", { method: "PUT", body: { ...edited, expectedVersion: 2 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.rig.currentLevels, { a: 1, b: 0 });
  assert.deepEqual(r.data.migrations, []);
  assert.equal(r.data.rig.name, "改名");
});

test("决策 feasible 标志与安全状态一致", async () => {
  const s = await server("feasible-flag");
  after(s.stop);
  const safe = await api(s.base, "/api/rigs/SD-002/decision?beaufort=1&direction=90");
  assert.equal(safe.data.decision.status, "safe");
  assert.equal(safe.data.decision.feasible, true);
  const no = await api(s.base, "/api/rigs/SD-002/decision?beaufort=10&direction=90");
  assert.equal(no.data.decision.status, "infeasible");
  assert.equal(no.data.decision.feasible, false);
});
