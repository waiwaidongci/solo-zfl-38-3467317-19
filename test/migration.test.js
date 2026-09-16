// 升级数据源选择与安全迁移：
//   1) 有运行时文件 -> 直接使用；2) 仅旧文件 -> 安全迁移；3) 都没有 -> 交付快照播种。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { JsonStore } from "../src/store.js";
import { seedData, legacySnapshot, SNAPSHOT_PATH } from "../src/seed.js";
import { tempDbFile, cleanup } from "./helpers.js";

async function tempPaths(label) {
  const { file, dir } = await tempDbFile(label); // file 尚不存在
  return { runtime: file, legacy: path.join(dir, "model-rigging-calibration.json"), dir };
}
const open = (runtime, legacy) => new JsonStore(runtime, seedData, { legacyPath: legacy });

function v1File(items = legacySnapshot().items) {
  return JSON.stringify({ items }, null, 2);
}

test("仅旧 v1 文件：迁移保留编号/任务/日志并补齐帆装，生成运行时文件", async () => {
  const { runtime, legacy, dir } = await tempPaths("m-v1");
  after(() => cleanup(dir));
  await writeFile(legacy, v1File(), "utf8");

  const store = open(runtime, legacy);
  const items = await store.listItems();
  const mr = items.find((i) => i.code === "MR-001");
  assert.equal(mr.id, "MR-001"); // 旧记录无 id，用 code 兜底
  assert.equal(mr.tasks.length, 2);
  assert.deepEqual(mr.tasks.map((t) => t.id), ["T-1", "T-1782013829186"]);
  assert.deepEqual(mr.tasks[0].logs, [{ at: "2026-06-12", note: "已缩短2mm" }]);
  assert.equal(mr.logs.length, 1);
  const rigs = await store.listRigs();
  assert.deepEqual(rigs.map((r) => r.code), ["FC-001", "SD-002"]); // 补齐种子帆装
  const onDisk = JSON.parse(await readFile(runtime, "utf8"));
  assert.equal(onDisk.fileVersion, 2);
  assert.equal(onDisk.migration.itemsImported, 1);
  assert.equal(onDisk.migration.rigsImported, 0);
  // 旧文件逐字未改
  assert.equal(await readFile(legacy, "utf8"), v1File());
});

test("双文件并存：直接使用运行时文件，忽略旧文件，不重复导入", async () => {
  const { runtime, legacy, dir } = await tempPaths("m-both");
  after(() => cleanup(dir));
  // 旧文件里是 MR-001
  await writeFile(legacy, v1File(), "utf8");
  // 运行时文件已存在且只有一个不同模型（模拟已迁移并持续写入后的状态）
  const seeded = {
    fileVersion: 2, version: 7, updatedAt: "2026-09-01T00:00:00Z",
    rigs: seedData().rigs,
    items: [{ id: "MR-EXISTING", code: "MR-EXISTING", shipType: "鸟船", status: "待检查", tasks: [], logs: [] }],
  };
  await writeFile(runtime, JSON.stringify(seeded), "utf8");

  const store = open(runtime, legacy);
  const items = await store.listItems();
  assert.deepEqual(items.map((i) => i.code), ["MR-EXISTING"]); // 旧文件未被导入
  const state = await store.read();
  assert.equal(state.version, 7); // 沿用运行时版本
  assert.equal(state.migration, undefined);
});

test("旧库损坏（坏 JSON / items 非数组 / 非对象）：拒绝迁移，两文件都保持可读", async () => {
  for (const bad of ["{oops", JSON.stringify({ items: "x" }), "42"]) {
    const { runtime, legacy, dir } = await tempPaths("m-corrupt");
    await writeFile(legacy, bad, "utf8");
    const store = open(runtime, legacy);
    await assert.rejects(() => store.read(), /旧数据文件|无法迁移/);
    assert.equal(existsSync(runtime), false); // 未生成半套运行时文件
    assert.equal(await readFile(legacy, "utf8"), bad); // 原文件原样
    await cleanup(dir);
  }
});

test("迁移中断（原子写失败）：旧文件不变、无半套副本，修复后重试成功", async () => {
  const { runtime, legacy, dir } = await tempPaths("m-interrupt");
  after(() => cleanup(dir));
  await writeFile(legacy, v1File(), "utf8");

  const store1 = open(runtime, legacy);
  store1._atomicWrite = async () => { throw new Error("ENOSPC simulated"); };
  await assert.rejects(() => store1.read(), /ENOSPC/);
  assert.equal(existsSync(runtime), false); // rename 未发生
  const leftovers = (await readdir(dir)).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(leftovers, []); // 半截临时文件已清
  assert.equal(await readFile(legacy, "utf8"), v1File());

  // 新实例重试：迁移成功
  const store2 = open(runtime, legacy);
  const items = await store2.listItems();
  assert.equal(items.find((i) => i.code === "MR-001").tasks.length, 2);
  assert.equal(existsSync(runtime), true);
});

test("重复启动：沿用迁移结果，不重复导入，后续写入不被覆盖", async () => {
  const { runtime, legacy, dir } = await tempPaths("m-restart");
  after(() => cleanup(dir));
  await writeFile(legacy, v1File(), "utf8");

  const s1 = open(runtime, legacy);
  await s1.applyMoves("FC-001", [{ sailId: "main", toLevel: 1 }], 1); // 迁移后写入
  await s1.mutateItem("MR-001", (it) => { it.logs.push({ at: "2026-09-16", step: "迁移后", note: "追加" }); });

  // 旧文件事后被“污染”也不应影响已迁移的运行时库
  await writeFile(legacy, v1File([{ code: "OTHER", tasks: [], logs: [] }]), "utf8");

  const s2 = open(runtime, legacy); // 模拟重启
  const items = await s2.listItems();
  assert.deepEqual(items.map((i) => i.code), ["MR-001"]); // 未重复导入 OTHER
  const mr = items.find((i) => i.code === "MR-001");
  assert.equal(mr.logs.some((l) => l.note === "追加"), true); // 后续写入保留
  const rigs = await s2.listRigs();
  assert.equal(rigs.find((r) => r.code === "FC-001").currentLevels.main, 1); // 档位保留
  assert.equal(rigs.find((r) => r.code === "FC-001").version, 2); // 版本延续
});

test("旧文件已含帆装（曾经的 v2 库）：迁移保留帆装档位与版本", async () => {
  const { runtime, legacy, dir } = await tempPaths("m-v2legacy");
  after(() => cleanup(dir));
  const seed = seedData();
  const rig = seed.rigs[0];
  const v2 = {
    fileVersion: 2, version: 9,
    rigs: [{ ...rig, currentLevels: { fore: 2, main: 3, mizzen: 1 }, version: 4 }],
    items: legacySnapshot().items,
  };
  await writeFile(legacy, JSON.stringify(v2), "utf8");
  const store = open(runtime, legacy);
  const rigs = await store.listRigs();
  assert.deepEqual(rigs[0].currentLevels, { fore: 2, main: 3, mizzen: 1 });
  assert.equal(rigs[0].version, 4);
  const state = await store.read();
  assert.equal(state.version, 9); // 文件级版本也保留
  assert.equal(state.migration.rigsImported, 1);
});

test("迁移后并发更新仍只有一个版本（CAS）", async () => {
  const { runtime, legacy, dir } = await tempPaths("m-concurrent");
  after(() => cleanup(dir));
  await writeFile(legacy, v1File(), "utf8");
  const store = open(runtime, legacy);
  const [r1, r2] = await Promise.allSettled([
    store.applyMoves("FC-001", [{ sailId: "main", toLevel: 1 }], 1),
    store.applyMoves("FC-001", [{ sailId: "fore", toLevel: 1 }], 1),
  ]);
  assert.equal(r1.status, "fulfilled");
  assert.equal(r2.status, "rejected");
  const rig = (await store.listRigs()).find((r) => r.code === "FC-001");
  assert.equal(rig.version, 2);
  const changed = Object.values(rig.currentLevels).filter((v) => v === 1);
  assert.equal(changed.length, 1);
});

test("迁移全程不改动交付快照", async () => {
  const { runtime, legacy, dir } = await tempPaths("m-snapshot");
  after(() => cleanup(dir));
  await writeFile(legacy, v1File(), "utf8");
  const h1 = createHash("sha256").update(await readFile(SNAPSHOT_PATH, "utf8")).digest("hex");
  const store = open(runtime, legacy);
  await store.listItems();
  const h2 = createHash("sha256").update(await readFile(SNAPSHOT_PATH, "utf8")).digest("hex");
  assert.equal(h1, h2);
});

test("两处都没有：从交付快照播种（旧台账两任务齐全）", async () => {
  const { runtime, legacy, dir } = await tempPaths("m-seed");
  after(() => cleanup(dir));
  const store = open(runtime, legacy); // legacy 不存在
  const items = await store.listItems();
  assert.equal(items.find((i) => i.code === "MR-001").tasks.length, 2);
  assert.equal((await store.listRigs()).length, 2);
});
