// 跨实例（跨进程）互斥：同一运行时库被多个 JsonStore 共享时的
// 同时首次迁移、迁移中更新、同版本并发写、重复启动、陈旧锁恢复与失败可读性。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, readdir, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { JsonStore, LockTimeoutError } from "../src/store.js";
import { FileLock } from "../src/file-lock.js";
import { seedData, legacySnapshot } from "../src/seed.js";
import { tempDbFile, cleanup } from "./helpers.js";

async function setup(label) {
  const { file: runtime, dir } = await tempDbFile(label);
  after(() => cleanup(dir));
  const legacy = path.join(dir, "model-rigging-calibration.json");
  await writeFile(legacy, JSON.stringify({ items: legacySnapshot().items }), "utf8");
  const open = (opts = {}) => new JsonStore(runtime, seedData, {
    legacyPath: legacy, lockWaitMs: 1500, staleMs: 150, ...opts,
  });
  return { runtime, legacy, dir, open };
}
const listTmpLocks = async (dir) =>
  (await readdir(dir)).filter((n) => n.endsWith(".lock") || n.includes(".tmp-"));

test("同时首次迁移：两个实例竞争，只迁移一次、都复用结果、无临时文件残留", async () => {
  const { open, runtime, dir } = await setup("xi-migrate-race");
  const [s1, s2] = [open(), open()];
  const [r1, r2] = await Promise.allSettled([s1.listItems(), s2.listItems()]);
  assert.equal(r1.status, "fulfilled");
  assert.equal(r2.status, "fulfilled");
  assert.equal(r1.value[0].tasks.length, 2);
  assert.equal(r2.value[0].tasks.length, 2);
  // 没有重复导入：只有 1 个模型
  assert.equal(r1.value.length, 1);
  assert.equal(r2.value.length, 1);
  const onDisk = JSON.parse(await readFile(runtime, "utf8"));
  assert.equal(onDisk.items.length, 1);
  assert.equal(onDisk.migration.itemsImported, 1);
  // 锁与临时文件都已释放/清理
  assert.deepEqual(await listTmpLocks(dir), []);
});

test("迁移中到达的更新：等待迁移完成后写入，版本顺序正确", async () => {
  const { open } = await setup("xi-update-during-migration");
  const s1 = open();
  const s2 = open();
  // 一个实例触发首次迁移，同时另一实例立刻提交更新
  const [mig, upd] = await Promise.all([
    s1.listItems(),
    s2.applyMoves("FC-001", [{ sailId: "main", toLevel: 1 }], 1),
  ]);
  assert.equal(mig[0].tasks.length, 2);
  assert.equal(upd.rig.version, 2); // 迁移态为 v1，更新后 v2
  assert.equal(upd.rig.currentLevels.main, 1);
  // 旧台账仍在
  const items = await s1.listItems();
  assert.equal(items[0].tasks.length, 2);
});

test("两个已加载实例按同一版本并发写：后写者明确失败，不覆盖先写", async () => {
  const { open } = await setup("xi-concurrent-write");
  const s1 = open();
  const s2 = open();
  await s1.listItems();
  await s2.listItems(); // 两实例都基于迁移后的 v1
  const [w1, w2] = await Promise.allSettled([
    s1.applyMoves("FC-001", [{ sailId: "main", toLevel: 1 }], 1),
    s2.applyMoves("FC-001", [{ sailId: "fore", toLevel: 1 }], 1),
  ]);
  assert.equal(w1.status, "fulfilled");
  assert.equal(w2.status, "rejected");
  assert.ok(w2.reason.code === "VERSION_CONFLICT" || w2.reason.code === "CONCURRENT_VERSION_CONFLICT");
  const disk = await s1.read();
  const rig = disk.rigs.find((r) => r.code === "FC-001");
  assert.equal(rig.version, 2);
  assert.deepEqual(rig.currentLevels, { fore: 0, main: 1, mizzen: 0 }); // 先写结果保留

  // 失败实例刷新后可见最新版本，并带正确版本重试成功
  const after = await s2.listRigs();
  assert.equal(after.find((r) => r.code === "FC-001").version, 2);
  const retry = await s2.applyMoves("FC-001", [{ sailId: "fore", toLevel: 1 }], 2);
  assert.equal(retry.rig.version, 3);
  assert.equal(retry.rig.currentLevels.fore, 1);
  assert.equal(retry.rig.currentLevels.main, 1);
});

test("跨实例延迟的旧版本写：另一实例已提交后，旧依据写入被拒", async () => {
  const { open } = await setup("xi-stale-write");
  const s1 = open();
  const s2 = open();
  await s1.listItems();
  await s2.listItems();
  await s1.applyMoves("FC-001", [{ sailId: "main", toLevel: 1 }], 1); // v2
  await s1.applyMoves("FC-001", [{ sailId: "main", toLevel: 2 }], 2); // v3
  // s2 仍持 v1 的认知
  await assert.rejects(
    () => s2.applyMoves("FC-001", [{ sailId: "fore", toLevel: 1 }], 1),
    (e) => e.code === "VERSION_CONFLICT" && e.currentVersion === 3
  );
});

test("重复启动：迁移只发生一次，版本与后续写入持续累积", async () => {
  const { open, runtime } = await setup("xi-restart");
  let s = open();
  await s.applyMoves("FC-001", [{ sailId: "main", toLevel: 1 }], 1);
  await s.mutateItem("MR-001", (it) => { it.logs.push({ at: "2026-09-16", step: "x", note: "n" }); });
  for (let i = 0; i < 3; i++) {
    s = open(); // 模拟进程重启
    const items = await s.listItems();
    assert.equal(items[0].tasks.length, 2);
    assert.equal(items[0].logs.some((l) => l.note === "n"), true);
  }
  const disk = JSON.parse(await readFile(runtime, "utf8"));
  assert.equal(disk.rigs.find((r) => r.code === "FC-001").version, 2);
  assert.equal(disk.migration.itemsImported, 1); // 始终只有一次迁移
});

test("陈旧锁恢复：死进程/损坏内容/超龄锁可被接管，操作成功且锁被替换", async () => {
  const { open, runtime, dir } = await setup("xi-stale-lock");
  await open().listItems(); // 先生成运行时库
  const lockPath = runtime + ".lock";
  await writeFile(lockPath, JSON.stringify({ token: "dead", pid: 999999, hostname: os.hostname(), startedAt: new Date(0).toISOString() }));
  await utimes(lockPath, new Date(0), new Date(0)); // mtime 超龄
  const s = open({ staleMs: 50 });
  const r = await s.applyMoves("FC-001", [{ sailId: "main", toLevel: 1 }], 1);
  assert.equal(r.rig.version, 2);
  // 损坏内容的锁同样可接管
  await writeFile(lockPath, "{not json");
  await utimes(lockPath, new Date(0), new Date(0));
  const r2 = await s.applyMoves("FC-001", [{ sailId: "main", toLevel: 2 }], 2);
  assert.equal(r2.rig.version, 3);
  assert.deepEqual(await listTmpLocks(dir), []);
});

test("活跃实例持锁时，其他实例等待超时明确失败，持锁方操作后可读", async () => {
  const { open, runtime } = await setup("xi-live-lock");
  await open().listItems();
  const external = new FileLock(runtime, { waitMs: 5000, staleMs: 30000 });
  const held = await external.acquire();
  try {
    const s = open({ lockWaitMs: 200, staleMs: 30000 });
    await assert.rejects(() => s.listItems(), LockTimeoutError);
  } finally {
    await held.release();
  }
  // 锁释放后正常
  const items = await open().listItems();
  assert.equal(items[0].code, "MR-001");
});

test("失败仍可读：旧库损坏时两实例都拒绝迁移、运行时不产生、旧文件原样", async () => {
  const { file: runtime, dir } = await tempDbFile("xi-bad-legacy");
  after(() => cleanup(dir));
  const legacy = path.join(dir, "model-rigging-calibration.json");
  await writeFile(legacy, "{ broken", "utf8");
  const mk = () => new JsonStore(runtime, seedData, { legacyPath: legacy, lockWaitMs: 500 });
  const [s1, s2] = [mk(), mk()];
  const [r1, r2] = await Promise.allSettled([s1.listItems(), s2.listItems()]);
  assert.equal(r1.status, "rejected");
  assert.equal(r2.status, "rejected");
  assert.match(r1.reason.message, /旧数据文件/);
  assert.equal(existsSync(runtime), false);
  assert.equal(await readFile(legacy, "utf8"), "{ broken");
  assert.deepEqual(await readdir(dir).then((ns) => ns.filter((n) => n.endsWith(".lock"))), []);
});
