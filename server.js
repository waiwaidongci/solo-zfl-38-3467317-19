import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { JsonStore } from "./src/store.js";
import { seedData } from "./src/seed.js";
import { createApp } from "./src/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function resolvePaths(env = process.env) {
  const defaultDb = join(__dirname, "data", "runtime.json");
  const defaultLegacy = join(__dirname, "data", "model-rigging-calibration.json");
  const dbPath = env.DB_PATH || defaultDb;
  const legacyPath = env.LEGACY_DB_PATH !== undefined
    ? (env.LEGACY_DB_PATH || null)
    : (dbPath === defaultDb ? defaultLegacy : null);
  return { dbPath, legacyPath, port: Number(env.PORT || 3038) };
}

// 启动预检：运行时库结构损坏（或迁移/播种产物非法）时拒绝启动，
// 不监听端口、非零退出；原文件保持不变，锁与临时文件由存储层清理。
export async function start({ env = process.env, exit = true } = {}) {
  const { dbPath, legacyPath, port } = resolvePaths(env);
  const store = new JsonStore(dbPath, seedData, { legacyPath });
  const h = await store.health();
  if (!h.ok) {
    console.error("启动失败：" + (h.error.message || h.error));
    if (exit) process.exit(2);
    return { ok: false, store, error: h.error };
  }
  const app = createApp(store);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(port, resolve));
  console.log("古船帆装配平与分级缩帆决策 listening on http://localhost:" + port);
  console.log("运行时数据文件：" + dbPath + (legacyPath ? "（旧文件：" + legacyPath + "）" : ""));
  return { ok: true, store, server };
}

// 仅作为入口执行时启动；被 import（测试/复用）时不自动监听
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
