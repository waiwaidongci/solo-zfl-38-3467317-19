// 旧版帆索校准台账快照回归：
//  - 交付快照 data/delivery/legacy-snapshot.json 永不被帆装/台账写入改写；
//  - 全新运行时库播种出的 MR-001（编号、每条任务、每条日志）与快照逐字段一致；
//  - 追加新模型/日志不改变旧记录；写入失败整体回滚，不留下半套状态；
//  - 重新打开（“重启”）后旧记录仍在。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JsonStore } from "../src/store.js";
import { seedData, legacySnapshot, SNAPSHOT_PATH } from "../src/seed.js";
import { tempDbFile, cleanup } from "./helpers.js";

const snapshotItem = () => legacySnapshot().items.find((i) => i.code === "MR-001");

// 只比对快照里存在的字段（运行时可能补 id，但不允许改动快照原始内容）
function comparable(item) {
  const snap = snapshotItem();
  const out = {};
  for (const k of Object.keys(snap)) {
    if (k === "tasks") {
      out.tasks = (item.tasks || []).slice(0, snap.tasks.length).map((t) => ({
        id: t.id, position: t.position, tension: t.tension, status: t.status,
        logs: (t.logs || []).map((l) => ({ ...l })),
      }));
    } else {
      out[k] = item[k];
    }
  }
  return out;
}

async function freshStore(label) {
  const { file, dir } = await tempDbFile(label);
  after(() => cleanup(dir));
  return { store: new JsonStore(file, seedData), file, dir };
}

test("全新运行时库：MR-001 编号、任务数量、每任务及日志与初始快照完全一致", async () => {
  const { store } = await freshStore("legacy-seed");
  const items = await store.listItems();
  const mr = items.find((i) => i.code === "MR-001");
  assert.ok(mr, "运行时库必须包含 MR-001");
  assert.deepEqual(comparable(mr), snapshotItem());
  // 明确关键不变量
  assert.equal(mr.tasks.length, 2);
  assert.deepEqual(mr.tasks.map((t) => t.id), ["T-1", "T-1782013829186"]);
  assert.deepEqual(mr.tasks[0].logs, [{ at: "2026-06-12", note: "已缩短2mm" }]);
  assert.deepEqual(mr.tasks[1].logs, [{ at: "2026-06-21T03:50:29.186Z", note: "回退半圈" }]);
  assert.deepEqual(mr.logs, [{ at: "2026-06-21T03:50:29.186Z", step: "帆索", note: "后桅升帆索 · 偏紧" }]);
});

test("追加新模型/日志不改动旧 MR-001；快照文件字节不变", async () => {
  const { store } = await freshStore("legacy-append");
  const before = await readFile(SNAPSHOT_PATH, "utf8");

  await store.addItem({
    id: "MR-900", code: "MR-900", shipType: "鸟船", owner: "新负责人", status: "待检查",
    tasks: [], logs: [{ at: "2026-09-16", step: "建档", note: "新模型" }],
  });
  await store.mutateItem("MR-900", (it) => {
    it.logs.push({ at: "2026-09-16", step: "帆索", note: "追加一条新日志" });
  });

  const items = await store.listItems();
  assert.equal(items.length, 2);
  const mr = items.find((i) => i.code === "MR-001");
  assert.deepEqual(comparable(mr), snapshotItem(), "旧 MR-001 被追加操作污染");
  const added = items.find((i) => i.code === "MR-900");
  assert.equal(added.logs.length, 2);

  const after = await readFile(SNAPSHOT_PATH, "utf8");
  assert.equal(after, before, "交付快照被写入改写");
});

test("帆装作业也不影响台账：多次缩帆后 MR-001 仍与快照一致", async () => {
  const { store } = await freshStore("legacy-rigs");
  const rigs = await store.listRigs();
  const fc = rigs.find((r) => r.code === "FC-001");
  await store.applyMoves("FC-001", [{ sailId: "main", toLevel: 1 }], fc.version);
  await store.applyMoves("FC-001", [{ sailId: "fore", toLevel: 1 }], fc.version + 1);
  const items = await store.listItems();
  assert.deepEqual(comparable(items.find((i) => i.code === "MR-001")), snapshotItem());
});

test("写入失败整体回滚：台账不留下半套状态", async () => {
  const { store } = await freshStore("legacy-rollback");
  await store.listItems(); // 触发播种落盘
  store._atomicWrite = async () => { throw new Error("ENOSPC simulated"); };
  await assert.rejects(
    () => store.addItem({ id: "MR-FAIL", code: "MR-FAIL", tasks: [], logs: [] }),
    /已回滚/
  );
  // 恢复写能力后，MR-001 仍在且与快照一致，失败的模型不存在
  store._atomicWrite = JsonStore.prototype._atomicWrite;
  const items = await store.listItems();
  assert.deepEqual(comparable(items.find((i) => i.code === "MR-001")), snapshotItem());
  assert.equal(items.some((i) => i.code === "MR-FAIL"), false);
});

test("重启后旧记录仍在（重新打开同一运行时库）", async () => {
  const { file, dir } = await tempDbFile("legacy-restart");
  const s1 = new JsonStore(file, seedData);
  const first = await s1.listItems();
  assert.equal(first.find((i) => i.code === "MR-001").tasks.length, 2);
  const s2 = new JsonStore(file, seedData); // 模拟新进程
  const again = await s2.listItems();
  assert.deepEqual(comparable(again.find((i) => i.code === "MR-001")), snapshotItem());
  await cleanup(dir);
});
