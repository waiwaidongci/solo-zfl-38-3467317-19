// 真实浏览器端到端：用 Playwright Chromium 走通
//   1) 安全路径  2) 降档路径（逐级作业 + 重启持久化）
//   3) 无解路径  4) 并发冲突路径（两个标签页，后写 409 → 拉取最新 → 成功）
//
// 运行：npm run test:e2e
// 本机 Chromium 依赖库解包在 ~/.local/chromelibs 时，通过 LD_LIBRARY_PATH 注入。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

import { chromium } from "playwright";
import { JsonStore } from "../src/store.js";
import { createApp } from "../src/app.js";
import { seedData } from "../src/seed.js";

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
