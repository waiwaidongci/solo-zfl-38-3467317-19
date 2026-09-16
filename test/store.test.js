import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { JsonStore } from "../src/store.js";
import { seedData } from "../src/seed.js";
import { ConflictError } from "../src/domain.js";
import { validateRig } from "../src/domain.js";
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

test("v1 旧数据文件自动迁移：items 保留、rigs 补齐、版本落盘", async () => {
  const { file, dir } = await tempDbFile("migrate");
  after(() => cleanup(dir));
  await writeFile(file, JSON.stringify({ items: [{ id: "OLD-1", code: "MR-OLD", status: "待检查" }] }), "utf8");
  const store = new JsonStore(file, seedData);
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
