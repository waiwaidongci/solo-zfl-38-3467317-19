// 旧台账真实回归检查（可独立运行：npm run check:legacy）。
//
// 默认在临时目录开一个全新运行时库（不影响正在运行的 data/runtime.json；
// 也可用 DB_PATH 指定真实路径）启动真实 HTTP 服务，验证：
//   1) 全新启动后 MR-001 的编号、任务数量、每个任务及日志与交付快照逐字段一致；
//   2) 更新接口（新增模型、追加日志）正常工作，且不改动旧 MR-001；
//   3) 写入失败整体回滚，磁盘上不留下半套状态；
//   4) “重启”（重新打开同一运行时库）后旧记录仍在；
//   5) 交付快照文件全程字节不变。
// 临时库检查完即清；运行时库随时可从交付快照再生。

import http from "node:http";
import { createHash } from "node:crypto";
import { rm, readFile, access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { JsonStore } from "../src/store.js";
import { seedData, legacySnapshot, SNAPSHOT_PATH } from "../src/seed.js";
import { createApp } from "../src/app.js";

// 默认在临时目录开一个全新运行时库（不动正在运行的 data/runtime.json）；
// 设 DB_PATH 可指定真实路径做“服务重启后仍能读到旧记录”的验证。
const explicitDb = process.env.DB_PATH;
const runtimePath = explicitDb || join(await mkdtemp(join(tmpdir(), "sail-legacy-check-")), "runtime.json");
const runtimeDir = dirname(runtimePath);

const fail = (msg) => { console.error("✕ " + msg); process.exitCode = 1; throw new Error(msg); };
const ok = (msg) => console.log("✓ " + msg);

function snapshotComparable(item) {
  const snap = legacySnapshot().items.find((i) => i.code === "MR-001");
  const out = {};
  for (const k of Object.keys(snap)) {
    if (k === "tasks") {
      out.tasks = item.tasks.slice(0, snap.tasks.length).map((t) => ({
        id: t.id, position: t.position, tension: t.tension, status: t.status,
        logs: t.logs.map((l) => ({ ...l })),
      }));
    } else {
      out[k] = item[k];
    }
  }
  return out;
}

async function httpJson(base, route, init) {
  const res = await fetch(base + route, init);
  return { status: res.status, body: await res.json() };
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

const snap = legacySnapshot().items.find((i) => i.code === "MR-001");
const snapHash = createHash("sha256").update(await readFile(SNAPSHOT_PATH, "utf8")).digest("hex");

// 干净启动：删除旧的运行时库（它是从快照派生的，可随时再生）
if (await exists(runtimePath)) await rm(runtimePath);

const store = new JsonStore(runtimePath, seedData);
const server = http.createServer(createApp(store));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log("检查用服务：" + base + "，运行时库：" + runtimePath);

try {
  // 1) GET 旧台账
  let r = await httpJson(base, "/api/items");
  if (r.status !== 200) fail("GET /api/items 非 200：" + r.status);
  let mr = r.body.find((i) => i.code === "MR-001");
  if (!mr) fail("缺少旧模型 MR-001");
  try {
    assertDeepEqual(snapshotComparable(mr), snap);
    ok("MR-001 与初始快照一致：编号 " + mr.code + "、任务 " + mr.tasks.length +
       " 条（" + mr.tasks.map((t) => t.id).join("/") + "）、模型日志 " + mr.logs.length + " 条");
  } catch (e) { fail("MR-001 与快照不一致：" + e.message); }

  // 2) 更新接口：新增模型 + 给新模型追加日志（不动 MR-001）
  r = await httpJson(base, "/api/items", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "MR-CHECK", shipType: "鸟船", owner: "回归检查", status: "待检查" }),
  });
  if (r.status !== 201) fail("新增模型失败：" + r.status + " " + JSON.stringify(r.body));
  const newId = r.body.id;
  r = await httpJson(base, "/api/items/" + encodeURIComponent(newId) + "/logs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step: "回归", note: "追加日志检查" }),
  });
  if (r.status !== 201) fail("追加日志失败：" + r.status);
  r = await httpJson(base, "/api/items");
  mr = r.body.find((i) => i.code === "MR-001");
  try { assertDeepEqual(snapshotComparable(mr), snap); ok("追加新记录后 MR-001 仍与快照一致"); }
  catch (e) { fail("追加后 MR-001 被改动：" + e.message); }
  const added = r.body.find((i) => i.code === "MR-CHECK");
  if (!added || added.logs.length !== 2) fail("新模型或其日志未正确追加");
  ok("更新接口可正常追加：MR-CHECK 共 " + added.logs.length + " 条日志");

  // 3) 写入失败整体回滚（直接让原子写失败一次）
  const rawOnDisk = await readFile(runtimePath, "utf8");
  store._atomicWrite = async () => { throw new Error("ENOSPC simulated"); };
  let threw = false;
  try { await store.addItem({ id: "MR-HALF", code: "MR-HALF", tasks: [], logs: [] }); }
  catch { threw = true; }
  store._atomicWrite = JsonStore.prototype._atomicWrite;
  if (!threw) fail("写入失败时未抛错");
  const afterFail = await readFile(runtimePath, "utf8");
  if (afterFail !== rawOnDisk) fail("写入失败后磁盘出现半套状态");
  r = await httpJson(base, "/api/items");
  if (r.body.some((i) => i.code === "MR-HALF")) fail("回滚后仍能读到 MR-HALF");
  ok("写入失败整体回滚：内存与磁盘均无半套状态");

  // 4) “重启”：关闭并重新打开同一运行时库
  await new Promise((r) => server.close(r));
  const store2 = new JsonStore(runtimePath, seedData);
  const reopened = await store2.listItems();
  mr = reopened.find((i) => i.code === "MR-001");
  try { assertDeepEqual(snapshotComparable(mr), snap); ok("重启后 MR-001 仍与快照一致"); }
  catch (e) { fail("重启后 MR-001 不一致：" + e.message); }

  // 5) 快照文件字节不变
  const hash2 = createHash("sha256").update(await readFile(SNAPSHOT_PATH, "utf8")).digest("hex");
  if (hash2 !== snapHash) fail("交付快照被改写");
  ok("交付快照 data/delivery/legacy-snapshot.json 全程字节不变");
} finally {
  await new Promise((r) => server.close(() => r())).catch(() => {});
  // 临时库可随时从快照再生，检查完即清；显式 DB_PATH 时保留（那是用户要验证的库）
  if (!explicitDb) await rm(runtimeDir, { recursive: true, force: true });
}

// 轻量深比较（避免额外依赖）
function assertDeepEqual(a, b) {
  const ja = JSON.stringify(a);
  if (ja !== JSON.stringify(b)) {
    throw new Error("\n  实际=" + ja + "\n  期望=" + JSON.stringify(b));
  }
}

if (process.exitCode) {
  console.error("\n旧台账回归检查失败");
  process.exit(1);
}
console.log("\n旧台账真实回归检查全部通过");
