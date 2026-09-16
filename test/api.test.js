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
  // currentLevels 保留
  assert.deepEqual(ok.data.rig.currentLevels, { fore: 0, main: 0, mizzen: 0 });
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
