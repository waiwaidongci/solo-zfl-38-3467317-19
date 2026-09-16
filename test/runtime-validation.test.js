// 运行时库结构严格校验：缺 items、非法嵌套、版本元数据损坏一律拒绝启动；
// 写前再次损坏拒绝覆盖；双实例并发启动都失败；不留 lock/tmp；旧版迁移仍兼容。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, readdir, rm, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";

import { JsonStore } from "../src/store.js";
import { CorruptDataError } from "../src/domain.js";
import { seedData, legacySnapshot, SNAPSHOT_PATH } from "../src/seed.js";
import { createApp } from "../src/app.js";
import { tempDbFile, cleanup } from "./helpers.js";
import { createHash } from "node:crypto";

async function paths(label) {
  const { file, dir } = await tempDbFile(label);
  after(() => cleanup(dir));
  const legacy = path.join(dir, "model-rigging-calibration.json");
  const open = () => new JsonStore(file, seedData, { legacyPath: null, lockWaitMs: 400 });
  return { file, dir, legacy, open };
}
const leftovers = async (dir) =>
  (await readdir(dir)).filter((n) => n.endsWith(".lock") || n.includes(".tmp-"));

// 合法运行时库基底（与迁移产物结构一致）
function validRuntime() {
  const s = seedData();
  return {
    fileVersion: 2, version: 1, updatedAt: "2026-09-16T00:00:00.000Z",
    rigs: s.rigs, items: legacySnapshot().items,
  };
}
async function writeRuntime(file, mutate) {
  const base = validRuntime();
  mutate(base);
  await writeFile(file, JSON.stringify(base), "utf8");
}

test("缺少台账 items 数组：拒绝启动，不兜底为空，原文件不变、无锁/临时残留", async () => {
  const { file, dir, open } = await paths("rv-no-items");
  await writeRuntime(file, (b) => { delete b.items; });
  const before = await readFile(file, "utf8");
  const store = open();
  await assert.rejects(() => store.listItems(), (e) => {
    assert.ok(e instanceof CorruptDataError);
    assert.ok(e.problems.some((p) => /items 必须是数组/.test(p)));
    return true;
  });
  assert.equal(await readFile(file, "utf8"), before); // 原文件逐字未改
  assert.deepEqual(await leftovers(dir), []);
  // 毒化后：读和写都不再用缓存/种子兜底
  await assert.rejects(() => store.listRigs(), CorruptDataError);
  await assert.rejects(
    () => store.addItem({ id: "X", code: "X", tasks: [], logs: [] }),
    CorruptDataError
  );
});

test("非法嵌套结构：任务/日志字段类型错误逐项拒绝", async () => {
  const cases = [
    [(b) => { b.items[0].tasks = "x"; }, /tasks 必须是数组/],
    [(b) => { b.items[0].tasks[0].logs = null; }, /logs 必须是数组/],
    [(b) => { b.items[0].tasks[0] = "bad"; }, /不是对象/],
    [(b) => { b.items[0].tasks[0].id = 7; }, /id 必须是非空字符串/],
    [(b) => { b.items[0].logs = [{ at: "2026-01-01" }]; }, /必须是 \{at:string,note:string\}/],
    [(b) => { b.items[0].code = ""; }, /code 必须是非空字符串/],
    [(b) => { b.rigs[0].currentLevels = { ghost: 1 }; }, /含未登记帆面/],
    [(b) => { b.rigs[0].currentLevels.main = 99; }, /超出 0\.\.3/],
    [(b) => { b.rigs[0].sails = "x"; }, /sails/],
    [(b) => { b.rigs = [{ code: "DUP" }, { code: "DUP" }]; }, /编号重复/],
  ];
  for (const [mutate, re] of cases) {
    const { file, open } = await paths("rv-nested");
    await writeRuntime(file, mutate);
    await assert.rejects(() => open().listItems(), (e) => {
      assert.ok(e instanceof CorruptDataError, "应为 CorruptDataError: " + re);
      assert.ok(e.problems.some((p) => re.test(p)), "应包含 " + re + "；实际: " + e.problems.join(" | "));
      return true;
    });
  }
});

test("版本元数据损坏（fileVersion/version/updatedAt）拒绝启动", async () => {
  for (const mutate of [
    (b) => { b.fileVersion = 1; },
    (b) => { b.version = "3"; },
    (b) => { b.version = 0; },
    (b) => { delete b.version; },
    (b) => { b.updatedAt = 123; },
    (b) => { delete b.updatedAt; },
  ]) {
    const { file, open } = await paths("rv-meta");
    await writeRuntime(file, mutate);
    await assert.rejects(() => open().listItems(), CorruptDataError);
  }
});

test("写前磁盘再次损坏：拒绝写入、不覆盖坏文件、实例毒化，原坏文件保持可读判断", async () => {
  const { file, open } = await paths("rv-tamper");
  const store = open();
  await store.listItems(); // 先正常加载
  // 外部把文件改成缺 items 的坏结构
  await writeRuntime(file, (b) => { b.items = null; });
  const broken = await readFile(file, "utf8");
  await assert.rejects(
    () => store.applyMoves("FC-001", [{ sailId: "main", toLevel: 1 }], 1),
    (e) => e instanceof CorruptDataError && /items 必须是数组/.test(e.message)
  );
  // 坏文件没有被覆盖
  assert.equal(await readFile(file, "utf8"), broken);
  // 同一实例之后的读也拒绝（不用旧缓存）
  await assert.rejects(() => store.listItems(), CorruptDataError);
});

test("双实例同时面对损坏运行时库：并发启动都失败、文件不变、无锁残留", async () => {
  const { file, dir, open } = await paths("rv-both-fail");
  await writeFile(file, "{ broken json", "utf8");
  const [s1, s2] = [open(), open()];
  const [r1, r2] = await Promise.allSettled([s1.listItems(), s2.listItems()]);
  assert.equal(r1.status, "rejected");
  assert.equal(r2.status, "rejected");
  assert.ok(r1.reason instanceof CorruptDataError);
  assert.ok(r2.reason instanceof CorruptDataError);
  assert.equal(await readFile(file, "utf8"), "{ broken json");
  assert.deepEqual(await leftovers(dir), []);
});

test("损坏运行时经 HTTP 返回 503 RUNTIME_CORRUPT，绝不返回空台账/空帆装", async () => {
  const { file, dir } = await tempDbFile("rv-http");
  after(() => cleanup(dir));
  await writeRuntime(file, (b) => { delete b.items; });
  const store = new JsonStore(file, seedData, { legacyPath: null });
  const server = http.createServer(createApp(store));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ["/health", "/api/items", "/api/rigs", "/api/rigs/FC-001"]) {
    const res = await fetch(base + route);
    assert.equal(res.status, 503, route);
    const body = await res.json();
    assert.equal(body.error, "RUNTIME_CORRUPT", route);
    assert.ok(body.problems?.length, route);
  }
});

test("旧版单文件迁移产物通过严格校验；第二次启动沿用、不重复迁移", async () => {
  const { file, legacy, open } = await paths("rv-migration");
  await writeFile(legacy, JSON.stringify({ items: legacySnapshot().items }), "utf8");
  const store = new JsonStore(file, seedData, { legacyPath: legacy });
  const items = await store.listItems();
  assert.equal(items[0].tasks.length, 2);
  // 迁移产物自身通过严格校验（_migrateLegacy 已在写盘前 validate）
  const migrated = JSON.parse(await readFile(file, "utf8"));
  assert.doesNotThrow(() => store._validateState(structuredClone(migrated)));
  // 迁移后继续写，再重开：沿用结果、不重复导入
  await store.applyMoves("FC-001", [{ sailId: "main", toLevel: 1 }], 1);
  const reopened = new JsonStore(file, seedData, { legacyPath: legacy });
  const again = await reopened.listItems();
  assert.equal(again.length, 1);
  assert.equal((await reopened.listRigs()).find((r) => r.code === "FC-001").currentLevels.main, 1);
});

test("损坏拒绝全程不改写交付快照", async () => {
  const hash1 = createHash("sha256").update(await readFile(SNAPSHOT_PATH, "utf8")).digest("hex");
  const { file, open } = await paths("rv-snapshot");
  await writeRuntime(file, (b) => { delete b.rigs; });
  await assert.rejects(() => open().listItems(), CorruptDataError);
  const hash2 = createHash("sha256").update(await readFile(SNAPSHOT_PATH, "utf8")).digest("hex");
  assert.equal(hash1, hash2);
});

test("启动入口：损坏库拒绝启动(ok:false,不监听)，合法库正常启动", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rv-entry-"));
  const file = path.join(dir, "runtime.json");
  const legacy = path.join(dir, "model-rigging-calibration.json");
  await writeRuntime(file, (b) => { delete b.items; });
  const entry = await import("../server.js");
  const bad = await entry.start({ env: { DB_PATH: file, LEGACY_DB_PATH: "", PORT: "0" }, exit: false });
  assert.equal(bad.ok, false);
  assert.ok(bad.error instanceof CorruptDataError);
  assert.ok(bad.error.problems.some((x) => /items 必须是数组/.test(x)));

  // 合法库（从旧文件迁移）可正常启动并响应
  await writeFile(legacy, JSON.stringify({ items: legacySnapshot().items }), "utf8");
  await rm(file, { force: true });
  const good = await entry.start({
    env: { DB_PATH: file, LEGACY_DB_PATH: legacy, PORT: String(0) }, exit: false,
  });
  assert.equal(good.ok, true);
  await new Promise((r) => good.server.close(r));
  await cleanup(dir);
});

test("写盘失败回滚：磁盘上始终是通过严格校验的旧结构", async () => {
  const { file, open } = await paths("rv-rollback");
  const store = open();
  await store.listItems();
  store._atomicWrite = async () => { throw new Error("ENOSPC simulated"); };
  await assert.rejects(
    () => store.addItem({ id: "MR-X", code: "MR-X", tasks: [], logs: [] }),
    /已回滚/
  );
  // 恢复后旧文件仍能通过严格校验并正常打开
  store._atomicWrite = JsonStore.prototype._atomicWrite;
  const again = open();
  const items = await again.listItems();
  assert.equal(items.some((i) => i.code === "MR-X"), false);
  assert.equal(existsSync(file), true);
});
