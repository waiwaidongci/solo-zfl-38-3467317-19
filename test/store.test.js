import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { JsonStore } from "../src/store.js";
import { seedData } from "../src/seed.js";
import { validateRig, ConflictError, ValidationError } from "../src/domain.js";
import { tempDbFile, cleanup, validRigInput } from "./helpers.js";

async function freshStore(label) {
  const { file, dir } = await tempDbFile(label);
  after(() => cleanup(dir));
  const store = new JsonStore(file, seedData);
  return { store, file };
}

function sampleRig(code = "X-1") {
  return validateRig(validRigInput({ code }));
}

test("新建船只版本从 1 开始并持久化", async () => {
  const { store } = await freshStore("create");
  const { version } = await store.createRig(sampleRig("N-1"));
  assert.equal(version, 1);
  const got = await store.getRig("N-1");
  assert.equal(got.version, 1);
  assert.deepEqual(got.currentLevels, { a: 0, b: 0 });
});

test("同 code 重复登记被拒绝（不可覆盖）", async () => {
  const { store } = await freshStore("dup");
  await store.createRig(sampleRig("N-2"));
  await assert.rejects(() => store.createRig(sampleRig("N-2")), ConflictError);
});

test("并发只产生一个版本：两个同 expectedVersion 的作业，只有一个成功", async () => {
  const { store } = await freshStore("cas");
  await store.createRig(sampleRig("C-1"));
  const moves1 = [{ sailId: "a", toLevel: 1 }];
  const moves2 = [{ sailId: "a", toLevel: 1 }];
  const [r1, r2] = await Promise.allSettled([
    store.applyMoves("C-1", moves1, 1),
    store.applyMoves("C-1", moves2, 1), // 同一过期依据
  ]);
  assert.equal(r1.status, "fulfilled");
  assert.equal(r2.status, "rejected");
  assert.ok(r2.reason instanceof ConflictError);
  assert.equal(r2.reason.currentVersion, 2);
  const rig = await store.getRig("C-1");
  assert.equal(rig.version, 2);
  assert.equal(rig.currentLevels.a, 1); // 只应用了一次
});

test("串行作业版本严格递增；跨版本引用必须带上最新版本", async () => {
  const { store } = await freshStore("seq");
  await store.createRig(sampleRig("S-1"));
  const r1 = await store.applyMoves("S-1", [{ sailId: "a", toLevel: 1 }], 1);
  assert.equal(r1.version, 2);
  // 用 v1 再写 -> 冲突
  await assert.rejects(
    () => store.applyMoves("S-1", [{ sailId: "b", toLevel: 1 }], 1),
    ConflictError
  );
  const r2 = await store.applyMoves("S-1", [{ sailId: "b", toLevel: 1 }], 2);
  assert.equal(r2.version, 3);
});

test("缺少 expectedVersion 拒绝（过期版本保护）", async () => {
  const { store } = await freshStore("nover");
  await store.createRig(sampleRig("V-1"));
  await assert.rejects(() => store.applyMoves("V-1", [{ sailId: "a", toLevel: 1 }], undefined), ConflictError);
  await assert.rejects(() => store.replaceRig("V-1", sampleRig("V-1"), undefined), ConflictError);
});

test("写入失败整体回滚：内存与文件都保持旧版本", async () => {
  const { store, file } = await freshStore("rollback");
  await store.createRig(sampleRig("R-1"));
  // 让原子写在 rename 前失败：把数据目录变成一个普通文件会破坏后续加载，
  // 因此用更稳妥的方式：直接替换实例的 _atomicWrite 抛错。
  store._atomicWrite = async () => { throw new Error("ENOSPC simulated"); };
  await assert.rejects(
    () => store.applyMoves("R-1", [{ sailId: "a", toLevel: 1 }], 1),
    /已回滚/
  );
  // 内存未变
  const rig = await store.getRig("R-1");
  assert.equal(rig.version, 1);
  assert.equal(rig.currentLevels.a, 0);
  // 文件仍是合法旧版本
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  const onRig = onDisk.rigs.find((r) => r.code === "R-1");
  assert.equal(onRig.version, 1);
  assert.equal(onRig.currentLevels.a, 0);
});

test("变更回调中业务校验失败同样回滚（不产生空版本）", async () => {
  const { store } = await freshStore("bizrollback");
  await store.createRig(sampleRig("B-1"));
  await assert.rejects(
    () => store.applyMoves("B-1", [{ sailId: "a", toLevel: 1 }], 99),
    ConflictError
  );
  const s = await store.read();
  assert.equal(s.version, 2); // create 后为 2，失败的写入不抬升总版本
});

test("重启持久化：新 store 指向同一文件，档位与版本延续", async () => {
  const { store, file } = await freshStore("restart");
  await store.createRig(sampleRig("P-1"));
  await store.applyMoves("P-1", [{ sailId: "a", toLevel: 1 }], 1);
  await store.applyMoves("P-1", [{ sailId: "a", toLevel: 2 }], 2);

  const reopened = new JsonStore(file, seedData);
  const rig = await reopened.getRig("P-1");
  assert.equal(rig.version, 3);
  assert.equal(rig.currentLevels.a, 2);
  // 再写一版（版本 4），用新进程风格的 JsonStore 也成功
  const r = await reopened.applyMoves("P-1", [{ sailId: "b", toLevel: 1 }], 3);
  assert.equal(r.version, 4);
});

test("运行时文件缺少 rigs（非法结构）拒绝启动而不是悄悄重建", async () => {
  const { file, dir } = await tempDbFile("bad-runtime");
  after(() => cleanup(dir));
  await writeFile(file, JSON.stringify({ items: [{ id: "OLD-1", code: "MR-OLD" }] }), "utf8");
  const store = new JsonStore(file, seedData);
  await assert.rejects(() => store.listItems(), /运行时数据文件/);
});

test("旧版数据文件经 legacyPath 安全迁移：items 保留、rigs 补齐", async () => {
  const { file, dir } = await tempDbFile("from-legacy");
  after(() => cleanup(dir));
  const legacy = file.replace(/db\.json$/, "model-rigging-calibration.json");
  await writeFile(legacy, JSON.stringify({ items: [{ id: "OLD-1", code: "MR-OLD", status: "待检查", tasks: [], logs: [] }] }), "utf8");
  const store = new JsonStore(file, seedData, { legacyPath: legacy });
  const items = await store.listItems();
  assert.equal(items[0].code, "MR-OLD");
  const rigs = await store.listRigs();
  assert.ok(rigs.length >= 2);
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  assert.equal(onDisk.fileVersion, 2);
  assert.ok(Array.isArray(onDisk.rigs));
  assert.equal(onDisk.items[0].code, "MR-OLD");
});

test("损坏文件拒绝启动而不是悄悄重建", async () => {
  const { file, dir } = await tempDbFile("corrupt");
  after(() => cleanup(dir));
  await writeFile(file, "{ not json", "utf8");
  const store = new JsonStore(file, seedData);
  await assert.rejects(() => store.read(), /损坏/);
});

test("无临时文件残留", async () => {
  const { store, file } = await freshStore("tmp");
  await store.createRig(sampleRig("T-9"));
  await store.applyMoves("T-9", [{ sailId: "a", toLevel: 1 }], 1);
  const fs = await import("node:fs/promises");
  const names = await fs.readdir(file.split("/").slice(0, -1).join("/"));
  assert.deepEqual(names.filter((n) => n.endsWith(".tmp-" + process.pid)), []);
});

// ---- 更新帆装定义时的档位兼容迁移 ----
function reefs(n) {
  const factors = [1, 0.65, 0.3];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(i === 0
      ? { level: 0, areaFactor: 1 }
      : { level: i, areaFactor: factors[i] ?? 0.2, centroidShift: { z: -i } });
  }
  return out;
}
function rigWithSails(sails, over = {}) {
  return validateRig(validRigInput({ code: "M-1", sails, ...over }));
}
const SAIL_A3 = { id: "a", name: "前帆", area: 40, centroid: { x: 6, z: 9 }, reefs: reefs(3) };
const SAIL_B3 = { id: "b", name: "主帆", area: 60, centroid: { x: 0, z: 12 }, reefs: reefs(3) };
const SAIL_A2 = { ...SAIL_A3, reefs: reefs(2) };
const SAIL_A1 = { ...SAIL_A3, reefs: reefs(1) };
const SAIL_C2 = { id: "c", name: "新帆", area: 15, centroid: { x: 3, z: 7 }, reefs: reefs(2) };

test("更新减档 clamp：末档越界钳到新末档，可继续逐级作业，迁移留痕", async () => {
  const { store } = await freshStore("mig-clamp");
  await store.createRig(rigWithSails([SAIL_A3, SAIL_B3]));
  await store.applyMoves("M-1", [{ sailId: "a", toLevel: 1 }], 1);
  await store.applyMoves("M-1", [{ sailId: "a", toLevel: 2 }], 2); // a 在 2 档（末档）
  const { rig, migrations, version } = await store.replaceRig(
    "M-1", rigWithSails([SAIL_A2, SAIL_B3]), 3, { levelPolicy: "clamp" }
  );
  assert.equal(version, 4);
  assert.equal(rig.currentLevels.a, 1); // 2 钳到 1
  assert.equal(rig.currentLevels.b, 0);
  assert.equal(migrations[0].action, "clamped");
  assert.ok(rig.levelMigrations.some((m) => m.sailId === "a" && m.from === 2 && m.to === 1));
  // 迁移后可继续逐级放帆
  const r = await store.applyMoves("M-1", [{ sailId: "a", toLevel: 0 }], 4);
  assert.equal(r.rig.currentLevels.a, 0);
});

test("更新减档 reject：整体拒绝且不部分落盘（版本、定义、档位、文件都不变）", async () => {
  const { store, file } = await freshStore("mig-reject");
  await store.createRig(rigWithSails([SAIL_A3, SAIL_B3]));
  await store.applyMoves("M-1", [{ sailId: "a", toLevel: 1 }], 1);
  await assert.rejects(
    () => store.replaceRig("M-1", rigWithSails([SAIL_A1, SAIL_B3]), 2, { levelPolicy: "reject" }),
    (e) => e instanceof ValidationError && e.errors.some((x) => x.code === "LEVEL_OUT_OF_RANGE")
  );
  const rig = await store.getRig("M-1");
  assert.equal(rig.version, 2);                 // 版本未抬升
  assert.equal(rig.sails[0].reefs.length, 3);   // 定义未变
  assert.equal(rig.currentLevels.a, 1);          // 档位未变
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  const onRig = onDisk.rigs.find((r) => r.code === "M-1");
  assert.equal(onRig.sails[0].reefs.length, 3);
  assert.equal(onRig.currentLevels.a, 1);
});

test("更新删帆/增帆 clamp：删档记录、新帆 0 档；reject 拦截收帆中删帆", async () => {
  const { store } = await freshStore("mig-sails");
  await store.createRig(rigWithSails([SAIL_A3, SAIL_B3]));
  await store.applyMoves("M-1", [{ sailId: "b", toLevel: 1 }], 1);
  // 移除 b（在 1 档），新增 c：clamp 成功并记录 removed+added
  const r1 = await store.replaceRig("M-1", rigWithSails([SAIL_A3, SAIL_C2]), 2, { levelPolicy: "clamp" });
  assert.deepEqual(r1.rig.currentLevels, { a: 0, c: 0 });
  assert.deepEqual(r1.migrations.map((m) => m.sailId + ":" + m.action).sort(), ["b:removed", "c:added"]);
  // reject 策略移除收帆中的帆：拒绝
  await store.applyMoves("M-1", [{ sailId: "c", toLevel: 1 }], 3);
  await assert.rejects(
    () => store.replaceRig("M-1", rigWithSails([SAIL_A3]), 4, { levelPolicy: "reject" }),
    (e) => e instanceof ValidationError && e.errors.some((x) => x.code === "LEVEL_SAIL_REMOVED")
  );
  const rig = await store.getRig("M-1");
  assert.equal(rig.version, 4); // 拒绝未抬版本
});

test("复用帆面编号：按新档数钳制，不另建档位键", async () => {
  const { store } = await freshStore("mig-reuse");
  await store.createRig(rigWithSails([SAIL_A3, SAIL_B3]));
  await store.applyMoves("M-1", [{ sailId: "a", toLevel: 2 }], 1);
  // a 编号复用但档数减到 0..1，且改名换形心
  const reused = { id: "a", name: "复用编号的新帆", area: 25, centroid: { x: 4, z: 8 }, reefs: reefs(2) };
  const r = await store.replaceRig("M-1", rigWithSails([reused, SAIL_B3]), 2, { levelPolicy: "clamp" });
  assert.deepEqual(Object.keys(r.rig.currentLevels).sort(), ["a", "b"]);
  assert.equal(r.rig.currentLevels.a, 1);
  assert.equal(r.rig.sails[0].name, "复用编号的新帆");
});

test("兼容更新（无档位冲突）不产生迁移记录、版本正常递增", async () => {
  const { store } = await freshStore("mig-clean");
  await store.createRig(rigWithSails([SAIL_A3, SAIL_B3]));
  const r = await store.replaceRig(
    "M-1", rigWithSails([SAIL_A3, SAIL_B3], { name: "仅改名" }), 1, { levelPolicy: "clamp" }
  );
  assert.equal(r.migrations.length, 0);
  assert.equal(r.rig.version, 2);
  assert.deepEqual(r.rig.currentLevels, { a: 0, b: 0 });
  assert.ok(!r.rig.logs?.some((l) => l.step === "档位兼容迁移"));
});
