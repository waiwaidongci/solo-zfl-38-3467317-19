// 真实浏览器端到端：用 Playwright Chromium 走通
//   1) 安全路径  2) 降档路径（逐级作业 + 重启持久化）
//   3) 无解路径  4) 并发冲突路径（两个标签页，后写 409 → 拉取最新 → 成功）
//
// 运行：npm run test:e2e
// 本机 Chromium 依赖库解包在 ~/.local/chromelibs 时，通过 LD_LIBRARY_PATH 注入。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

import { chromium } from "playwright";
import { JsonStore } from "../src/store.js";
import { createApp } from "../src/app.js";
import { seedData, legacySnapshot } from "../src/seed.js";

// 本地解包的 Chromium 运行库（无 root 环境）
const EXTRA_LIB = [
  "/home/node/.local/chromelibs/usr/lib/aarch64-linux-gnu",
  "/home/node/.local/chromelibs/lib/aarch64-linux-gnu",
].join(":");
process.env.LD_LIBRARY_PATH = EXTRA_LIB + ":" + (process.env.LD_LIBRARY_PATH || "");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shotDir = path.join(__dirname, "..", "test-results", "screenshots");

async function startServer(file) {
  const store = new JsonStore(file, seedData);
  const server = http.createServer(createApp(store));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, stop: () => new Promise((resolve) => server.close(() => resolve())) };
}

let browser;
test.before(async () => {
  await mkdir(shotDir, { recursive: true });
  try {
    browser = await chromium.launch();
  } catch (e) {
    console.error("无法启动 Chromium，跳过浏览器 E2E：", e.message);
    process.exit(0);
  }
});
test.after(async () => { if (browser) await browser.close(); });

test("浏览器四条路径：安全 / 降档 / 无解 / 冲突（含重启持久化）", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sail-e2e-"));
  const file = path.join(dir, "db.json");
  const srv = await startServer(file);
  t.after(async () => { await srv.stop(); await rm(dir, { recursive: true, force: true }); });

  const pageA = await browser.newPage();
  const errors = [];
  pageA.on("pageerror", (e) => errors.push(String(e)));
  await pageA.goto(srv.base);
  await pageA.waitForSelector(".rigline");
  await pageA.screenshot({ path: path.join(shotDir, "01-overview.png"), fullPage: true });

  async function selectRig(page, code) {
    await page.click(`.rigline[data-code="${code}"]`);
    await page.waitForFunction(
      (v) => document.querySelector("#storeVer") && document.querySelector("#storeVer").textContent.includes(v),
      code
    );
  }
  async function setBeaufort(page, level) {
    await page.selectOption("#beaufort", String(level));
    await page.waitForTimeout(120);
  }
  async function bannerText(page) {
    return page.textContent(".banner");
  }

  // ---------- 路径 1：安全 ----------
  await selectRig(pageA, "FC-001");
  await setBeaufort(pageA, 3);
  await pageA.waitForSelector(".banner.safe");
  const safeText = await bannerText(pageA);
  assert.match(safeText, /安全/);
  assert.match(await pageA.textContent("#decisionPanel"), /最大安全风级/);
  // 帆面中心图与安全包络图都已渲染
  assert.ok((await pageA.locator("#sailPlan svg").count()) === 1);
  assert.ok((await pageA.locator("#envelope svg").count()) === 1);
  assert.match(await pageA.textContent("#envelope"), /最大安全 5 级/);
  await pageA.screenshot({ path: path.join(shotDir, "02-safe.png") });

  // ---------- 路径 2：降档（逐级）----------
  await setBeaufort(pageA, 9);
  await pageA.waitForSelector(".banner.reef");
  const reefText = await bannerText(pageA);
  assert.match(reefText, /必须缩帆/);
  await pageA.screenshot({ path: path.join(shotDir, "03-reef-required.png") });

  // 单帆“收”按钮：每次只变动一档；验证当前档位文本 0 → 1
  const levelBefore = await pageA.textContent("#reefControls .sailrow .lvl");
  assert.match(levelBefore, /0 \/ 3/);
  await pageA.click('.lvlbtn[data-op="in"][data-sail="main"]');
  await pageA.waitForFunction(() => /1 \/ 3 档/.test(
    document.querySelector('#reefControls .sailrow:has([data-sail="main"]) .lvl').textContent
  ));
  const verAfterOne = await pageA.textContent("#storeVer");
  assert.match(verAfterOne, /v2/);
  await pageA.screenshot({ path: path.join(shotDir, "04-reef-one-step.png") });

  // 连续“按建议执行第一步”，直到安全（每步都是 ±1 的合法单档，页面保证不跳档）
  let guard = 0;
  while ((await pageA.locator("#applyFirst").isEnabled()) && guard < 12) {
    await pageA.click("#applyFirst");
    await pageA.waitForTimeout(100);
    guard++;
  }
  await pageA.waitForSelector(".banner.safe");
  assert.match(await bannerText(pageA), /安全/);
  const verFinal = await pageA.textContent("#storeVer");
  assert.match(verFinal, /v/);
  await pageA.screenshot({ path: path.join(shotDir, "05-reef-safe-after-steps.png"), fullPage: true });

  assert.equal(errors.length, 0, "页面出现 JS 错误：" + errors.join(" | "));

  // 重启持久化：停服务再起一个同文件的实例，页面刷新后档位还在
  await srv.stop();
  const srv2 = await startServer(file);
  t.after(async () => srv2.stop());
  await pageA.goto(srv2.base);
  await selectRig(pageA, "FC-001");
  // 收过帆：至少一面帆档位 ≥ 1，版本延续
  const levelsText = await pageA.textContent("#reefControls");
  assert.ok(/[123] \/ 3 档/.test(levelsText), "重启后档位丢失：" + levelsText);
  assert.match(await pageA.textContent("#storeVer"), /v(?!1\b)\d+/);
  await pageA.evaluate(() => window.scrollTo(0, 0));
  await pageA.waitForTimeout(80);
  await pageA.screenshot({ path: path.join(shotDir, "06-after-restart.png") });
  // ---------- 路径 3：无解 ----------
  await selectRig(pageA, "SD-002");
  await setBeaufort(pageA, 8);
  await pageA.waitForSelector(".banner.bad");
  assert.match(await bannerText(pageA), /无解/);
  assert.match(await pageA.textContent("#decisionPanel"), /避风|航向|压载/);
  assert.equal(await pageA.locator("#applyFirst").isEnabled(), false);
  await pageA.screenshot({ path: path.join(shotDir, "07-infeasible.png") });

  // ---------- 路径 4：并发冲突 ----------
  await selectRig(pageA, "SD-002");
  await setBeaufort(pageA, 4); // SD-002 在 4 级需要降档，作业按钮可用
  const pageB = await browser.newPage();
  t.after(() => pageB.close());
  await pageB.goto(srv2.base);
  await selectRig(pageB, "SD-002");
  await pageB.selectOption("#beaufort", "4");
  await pageB.waitForTimeout(100);

  // A 先收主帆：v1 → v2
  await pageA.click('.lvlbtn[data-op="in"][data-sail="main"]');
  await pageA.waitForFunction(() => /v2/.test(document.querySelector("#storeVer").textContent));
  // B 仍基于 v1，收前帆 -> 409 冲突横幅
  await pageB.click('.lvlbtn[data-op="in"][data-sail="fore"]');
  await pageB.waitForSelector("#conflictBox", { state: "visible" });
  const conflictText = await pageB.textContent("#conflictBox");
  assert.match(conflictText, /版本冲突/);
  await pageB.evaluate(() => window.scrollTo(0, 0));
  await pageB.waitForTimeout(80);
  await pageB.screenshot({ path: path.join(shotDir, "08-conflict.png") });

  // B 的档位未被错误改动（仍 0 档）
  const bLevels = await pageB.textContent("#reefControls");
  assert.match(bLevels, /前桅帆[\s\S]*?0 \/ 3/);

  // 拉取最新版本后，B 能看到 A 的作业并成功收自己的前帆
  await pageB.click("#conflictReload");
  await pageB.waitForFunction(() => /主桅帆[\s\S]*?1 \/ 3/.test(document.querySelector("#reefControls").textContent));
  await pageB.click('.lvlbtn[data-op="in"][data-sail="fore"]');
  await pageB.waitForSelector(".banner");
  const finalText = await pageB.textContent("#reefControls");
  assert.match(finalText, /前桅帆[\s\S]*?1 \/ 3/);
  assert.match(finalText, /主桅帆[\s\S]*?1 \/ 3/);
  await pageB.evaluate(() => window.scrollTo(0, 0));
  await pageB.waitForTimeout(80);
  await pageB.screenshot({ path: path.join(shotDir, "09-conflict-recovered.png") });

  await pageA.close();
});

test("浏览器更新帆装定义：减档钳制迁移、reject 整体拒绝、增删帆留痕", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sail-rigupdate-"));
  const file = path.join(dir, "db.json");
  const srv = await startServer(file);
  t.after(async () => { await srv.stop(); await rm(dir, { recursive: true, force: true }); });

  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(srv.base);
  await page.waitForSelector(".rigline");
  await page.click('.rigline[data-code="FC-001"]');
  await page.waitForFunction(() => /FC-001/.test(document.querySelector("#storeVer").textContent));

  // 先在页面上把主桅帆连续收至 3 档（末档）
  await page.selectOption("#beaufort", "9");
  for (let i = 0; i < 3; i++) {
    await page.click('.lvlbtn[data-op="in"][data-sail="main"]');
    await page.waitForTimeout(60);
  }
  await page.waitForFunction(() => /3 \/ 3 档/.test(
    document.querySelector('#reefControls .sailrow:has([data-sail="main"]) .lvl').textContent
  ));
  const v3 = await page.textContent("#storeVer");
  assert.match(v3, /v4/);

  // 在浏览器内通过 fetch 拿到当前定义、把主桅帆缩帆档减为 0/1 两档
  const editRig = await page.evaluate(async (base) => {
    const get = await fetch(base + "/api/rigs/FC-001").then((r) => r.json());
    const rig = get.rig;
    rig.sails = rig.sails.map((s) => s.id === "main"
      ? { ...s, reefs: s.reefs.filter((r) => r.level <= 1) }
      : s);
    return rig;
  }, srv.base);

  // 填进登记 JSON 框，策略 clamp，点“按当前版本更新”
  await page.fill("#regJson", JSON.stringify(editRig));
  await page.selectOption("#levelPolicy", "clamp");
  await page.click("#regUpdate");
  await page.waitForFunction(() => /v5/.test(document.querySelector("#storeVer").textContent));
  // 主桅帆档数变 2、当前档由 3 钳到 1
  await page.waitForFunction(() => /1 \/ 1 档/.test(
    document.querySelector('#reefControls .sailrow:has([data-sail="main"]) .lvl').textContent
  ));
  const levelText = await page.textContent("#reefControls");
  assert.match(levelText, /主桅帆[\s\S]*?1 \/ 1 档/);
  await page.waitForFunction(() => /FC-001 v5/.test(document.querySelector("#regTarget").selectedOptions[0].textContent));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(shotDir, "10-rig-update-clamped.png") });

  // 决策接口仍正常（不再锁死）；B7 需要继续收前/尾帆（reef_required 且 feasible=true）
  const decOk = await page.evaluate(async (base) => {
    const [r7, r9] = await Promise.all([
      fetch(base + "/api/rigs/FC-001/decision?beaufort=7&direction=90").then((x) => x.json()),
      fetch(base + "/api/rigs/FC-001/decision?beaufort=9&direction=90").then((x) => x.json()),
    ]);
    return { b7: { status: r7.decision.status, feasible: r7.decision.feasible },
             b9: { status: r9.decision.status, feasible: r9.decision.feasible } };
  }, srv.base);
  assert.equal(decOk.b7.status, "reef_required");
  assert.equal(decOk.b7.feasible, true);
  assert.equal(decOk.b9.feasible, decOk.b9.status !== "infeasible");

  // reject 策略：把主桅帆再减成只有 0 档（当前 1 档会越界），应整体 422
  const editRig2 = await page.evaluate(async (base) => {
    const get = await fetch(base + "/api/rigs/FC-001").then((r) => r.json());
    const rig = get.rig;
    rig.expectedVersion = rig.version;
    rig.levelPolicy = "reject";
    rig.sails = rig.sails.map((s) => s.id === "main"
      ? { ...s, reefs: s.reefs.filter((r) => r.level === 0) }
      : s);
    const resp = await fetch(base + "/api/rigs/FC-001", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rig),
    });
    return { status: resp.status, body: await resp.json() };
  }, srv.base);
  assert.equal(editRig2.status, 422);
  assert.ok(editRig2.body.details.some((d) => d.code === "LEVEL_OUT_OF_RANGE"));
  // 未部分落盘：刷新后版本仍 v5、主桅帆仍是两档定义、档位 1
  await page.click("#reload");
  await page.waitForTimeout(150);
  await page.click('.rigline[data-code="FC-001"]');
  await page.waitForFunction(() => /v5/.test(document.querySelector("#storeVer").textContent));
  const afterText = await page.textContent("#reefControls");
  assert.match(afterText, /主桅帆[\s\S]*?1 \/ 1 档/);

  // 增/删帆：移除尾桅帆、新增一面副帆（clamp，页面表单）
  const editRig3 = await page.evaluate(async (base) => {
    const get = await fetch(base + "/api/rigs/FC-001").then((r) => r.json());
    const rig = get.rig;
    rig.sails = rig.sails.filter((s) => s.id !== "mizzen");
    rig.sails.push({ id: "spinnaker", name: "副帆", area: 12, centroid: { x: 7, y: 0, z: 10 },
      reefs: [{ level: 0, areaFactor: 1 }, { level: 1, areaFactor: 0.4 }] });
    return rig;
  }, srv.base);
  await page.fill("#regJson", JSON.stringify(editRig3));
  await page.selectOption("#levelPolicy", "clamp");
  await page.click("#regUpdate");
  await page.waitForFunction(() => /v6/.test(document.querySelector("#storeVer").textContent));
  const finalText = await page.textContent("#reefControls");
  assert.match(finalText, /前桅帆/);
  assert.match(finalText, /主桅帆/);
  assert.match(finalText, /副帆[\s\S]*?0 \/ 1 档/);
  assert.ok(!/尾桅帆/.test(finalText), "尾桅帆定义应已移除");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(shotDir, "11-rig-update-sails.png") });

  assert.equal(errors.length, 0, "页面 JS 错误：" + errors.join(" | "));
  await page.close();
});

test("浏览器旧台账：两条任务与模型日志可见，可追加且旧记录不变", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sail-legacy-"));
  const file = path.join(dir, "db.json");
  const srv = await startServer(file);
  t.after(async () => { await srv.stop(); await rm(dir, { recursive: true, force: true }); });

  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(srv.base);

  // 展开旧版台账
  await page.click("summary");
  await page.waitForSelector("#mList");
  const text = await page.textContent("#mList");
  assert.match(text, /MR-001/);
  assert.match(text, /T-1[\s\S]*?前桅侧支索[\s\S]*?已缩短2mm/);
  assert.match(text, /T-1782013829186[\s\S]*?后桅升帆索[\s\S]*?回退半圈/);
  assert.match(text, /模型日志（1 条）[\s\S]*?后桅升帆索 · 偏紧/);
  await page.screenshot({ path: path.join(shotDir, "12-legacy-ledger.png"), fullPage: true });

  // 通过页面输入框给 MR-001 追加一条模型日志（id 缺失时回退 code）
  const before = await page.textContent("#mList");
  await page.fill('.m-log-note[data-id="MR-001"]', "浏览器回归追加");
  await page.click('.m-log-btn[data-id="MR-001"]');
  await page.waitForFunction(
    () => /模型日志（2 条）/.test(document.querySelector("#mList").textContent) &&
          /浏览器回归追加/.test(document.querySelector("#mList").textContent)
  );
  const after = await page.textContent("#mList");
  // 旧的两条帆索任务与原日志都还在
  assert.match(after, /T-1[\s\S]*?前桅侧支索[\s\S]*?已缩短2mm/);
  assert.match(after, /T-1782013829186[\s\S]*?后桅升帆索[\s\S]*?回退半圈/);
  assert.match(after, /后桅升帆索 · 偏紧/);
  assert.match(after, /浏览器回归追加/);

  // 追加新模型也不影响 MR-001
  await page.fill("#mCode", "MR-E2E");
  await page.fill("#mType", "鸟船");
  await page.fill("#mOwner", "浏览器");
  await page.click("#mAdd");
  await page.waitForFunction(() => /MR-E2E/.test(document.querySelector("#mList").textContent));
  const withNew = await page.textContent("#mList");
  assert.match(withNew, /MR-001/);
  assert.match(withNew, /MR-E2E/);
  assert.match(withNew, /前桅侧支索/);
  await page.screenshot({ path: path.join(shotDir, "13-legacy-append.png"), fullPage: true });

  // 接口核对：快照字段完全一致
  const items = await page.evaluate(async (base) =>
    (await fetch(base + "/api/items").then((r) => r.json())), srv.base);
  const mr = items.find((i) => i.code === "MR-001");
  assert.deepEqual(mr.tasks.map((x) => x.id), ["T-1", "T-1782013829186"]);
  assert.deepEqual(mr.tasks[0].logs, [{ at: "2026-06-12", note: "已缩短2mm" }]);
  assert.deepEqual(mr.tasks[1].logs, [{ at: "2026-06-21T03:50:29.186Z", note: "回退半圈" }]);
  assert.equal(mr.logs.filter((l) => l.note === "后桅升帆索 · 偏紧").length, 1);
  assert.equal(mr.logs.filter((l) => l.note === "浏览器回归追加").length, 1);

  // 新帆装功能仍然正常：切到 FC-001 能出决策
  await page.click('.rigline[data-code="FC-001"]');
  await page.waitForSelector(".banner");
  assert.ok(await page.locator("#envelope svg").count() === 1);

  assert.equal(errors.length, 0, "页面 JS 错误：" + errors.join(" | "));
  await page.close();
});

test("浏览器升级迁移：仅旧文件时迁移，台账与帆装并存，重启沿用结果", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sail-migrate-"));
  const runtime = path.join(dir, "runtime.json");
  const legacy = path.join(dir, "model-rigging-calibration.json");
  // 只放旧版 v1 台账文件，不建运行时文件
  await writeFile(legacy, JSON.stringify({ items: legacySnapshot().items }), "utf8");
  const startMig = async () => {
    const store = new JsonStore(runtime, seedData, { legacyPath: legacy });
    const server = http.createServer(createApp(store));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { base: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((resolve) => server.close(() => resolve())) };
  };

  const srv = await startMig();
  t.after(async () => { await srv.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); });

  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(srv.base);

  // 帆装已补齐且可用
  await page.waitForSelector(".rigline");
  await page.click('.rigline[data-code="FC-001"]');
  await page.waitForSelector(".banner");
  assert.ok(await page.locator("#envelope svg").count() === 1);

  // 旧台账两条任务与模型日志都在
  await page.click("summary");
  await page.waitForSelector("#mList");
  const text = await page.textContent("#mList");
  assert.match(text, /T-1[\s\S]*?前桅侧支索[\s\S]*?已缩短2mm/);
  assert.match(text, /T-1782013829186[\s\S]*?后桅升帆索[\s\S]*?回退半圈/);
  assert.match(text, /模型日志（1 条）/);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.screenshot({ path: path.join(shotDir, "14-upgrade-migration.png"), fullPage: true });

  // 迁移后写入：收一档帆 + 追加台账日志
  await page.click('.lvlbtn[data-op="in"][data-sail="main"]');
  await page.waitForFunction(() => /v2/.test(document.querySelector("#storeVer").textContent));
  await page.fill('.m-log-note[data-id="MR-001"]', "迁移后浏览器追加");
  await page.click('.m-log-btn[data-id="MR-001"]');
  await page.waitForFunction(() => /迁移后浏览器追加/.test(document.querySelector("#mList").textContent));

  // 重启：沿用迁移结果（v2、主帆 1 档、新日志），不重复导入
  await srv.stop();
  const srv2 = await startMig();
  t.after(() => srv2.stop().catch(() => {}));
  await page.goto(srv2.base);
  await page.click('.rigline[data-code="FC-001"]');
  await page.waitForFunction(() => /v2/.test(document.querySelector("#storeVer").textContent));
  const level = await page.textContent('#reefControls .sailrow:has([data-sail="main"]) .lvl');
  assert.match(level, /1 \/ 3/);
  await page.click("summary");
  await page.waitForSelector("#mList");
  const text2 = await page.textContent("#mList");
  assert.match(text2, /前桅侧支索/);
  assert.match(text2, /后桅升帆索/);
  assert.match(text2, /迁移后浏览器追加/);
  assert.match(text2, /模型日志（2 条）/);

  assert.equal(errors.length, 0, "页面 JS 错误：" + errors.join(" | "));
  await page.close();
});

test("浏览器双实例共享库：同时迁移不重复、同版本并发写一方冲突后可恢复", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sail-xi-"));
  const runtime = path.join(dir, "runtime.json");
  const legacy = path.join(dir, "model-rigging-calibration.json");
  await writeFile(legacy, JSON.stringify({ items: legacySnapshot().items }), "utf8");

  const startShared = async () => {
    const store = new JsonStore(runtime, seedData, { legacyPath: legacy, lockWaitMs: 4000 });
    const server = http.createServer(createApp(store));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { base: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((resolve) => server.close(() => resolve())) };
  };

  // 两个实例同时首启（runtime.json 尚不存在）
  const [s1, s2] = await Promise.all([startShared(), startShared()]);
  t.after(async () => { await s1.stop().catch(() => {}); await s2.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); });

  // 两侧页面同时加载，竞争首次迁移
  const page1 = await browser.newPage();
  const page2 = await browser.newPage();
  t.after(() => Promise.all([page1.close(), page2.close()]));
  await Promise.all([
    page1.goto(s1.base).then(() => page1.waitForSelector(".rigline")),
    page2.goto(s2.base).then(() => page2.waitForSelector(".rigline")),
  ]);

  // 两侧都看到帆装与旧台账，且迁移只发生一次
  for (const p of [page1, page2]) {
    await p.click("summary");
    await p.waitForSelector("#mList");
    assert.match(await p.textContent("#mList"), /前桅侧支索[\s\S]*?后桅升帆索/);
  }
  const onDisk = JSON.parse(await readFile(runtime, "utf8"));
  assert.equal(onDisk.items.length, 1);
  assert.equal(onDisk.migration.itemsImported, 1);

  // 两实例都停在 v1：测试侧（Node）对两个端口并发提交同版本作业，避免页面跨端口 CORS
  const postReef = (base, sailId) => fetch(base + "/api/rigs/FC-001/reef", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ moves: [{ sailId, toLevel: 1 }], expectedVersion: 1 }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const results = await Promise.all([postReef(s1.base, "main"), postReef(s2.base, "fore")]);
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 409]);
  const conflict = results.find((r) => r.status === 409);
  assert.match(conflict.body.error, /VERSION_CONFLICT/);

  // 失败侧刷新后看到先写结果（main=1, fore=0），带 v2 重试成功
  await page2.click("#reload");
  await page2.waitForTimeout(150);
  await page2.click('.rigline[data-code="FC-001"]');
  await page2.waitForFunction(() => /主桅帆[\s\S]*?1 \/ 3/.test(document.querySelector("#reefControls").textContent));
  const retry = await page2.evaluate(async (base) => {
    const r = await fetch(base + "/api/rigs/FC-001/reef", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moves: [{ sailId: "fore", toLevel: 1 }], expectedVersion: 2 }),
    });
    return { status: r.status };
  }, s2.base);
  assert.equal(retry.status, 200);
  const finalDisk = JSON.parse(await readFile(runtime, "utf8"));
  const rig = finalDisk.rigs.find((r) => r.code === "FC-001");
  assert.equal(rig.version, 3);
  assert.deepEqual(rig.currentLevels, { fore: 1, main: 1, mizzen: 0 });

  // 锁文件释放、无临时残留
  const leftovers = (await readdir(dir)).filter((n) => n.endsWith(".lock") || n.includes(".tmp-"));
  assert.deepEqual(leftovers, []);
  await page1.evaluate(() => window.scrollTo(0, 0));
  await page1.screenshot({ path: path.join(shotDir, "15-cross-instance.png") });
});

test("浏览器拒绝启动：运行时库结构损坏时显示致命横幅，不显示空数据", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sail-corrupt-"));
  const file = path.join(dir, "runtime.json");
  // 先建一份合法库，再删掉 items 模拟“缺少台账数组”
  await writeFile(file, JSON.stringify({
    fileVersion: 2, version: 1, updatedAt: "2026-09-16T00:00:00Z",
    rigs: seedData().rigs,
  }), "utf8");
  const store = new JsonStore(file, seedData, { legacyPath: null });
  const server = http.createServer(createApp(store));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { await new Promise((res) => server.close(() => res())); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(base);
  await page.waitForSelector("#fatalBox", { state: "visible" });
  const fatal = await page.textContent("#fatalBox");
  assert.match(fatal, /拒绝启动/);
  assert.match(fatal, /items 必须是数组/);
  // 船只列表不显示空帆装，而是数据不可用
  assert.match(await page.textContent("#rigList"), /数据不可用/);
  // 台账也不显示空模型
  await page.click("summary");
  await page.waitForTimeout(100);
  assert.doesNotMatch(await page.textContent("#mList"), /MR-001/);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(shotDir, "16-runtime-corrupt.png") });
});
