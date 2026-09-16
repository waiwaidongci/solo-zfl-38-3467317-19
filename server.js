import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { JsonStore } from "./src/store.js";
import { seedData } from "./src/seed.js";
import { createApp } from "./src/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 交付数据（只读快照）在 data/delivery/；运行时可写数据库默认在 data/runtime.json，
// 两者分离：帆装功能启动/更新/测试都不会改写交付快照。可用 DB_PATH 覆盖。
const defaultDb = join(__dirname, "data", "runtime.json");
const defaultLegacy = join(__dirname, "data", "model-rigging-calibration.json");
const dbPath = process.env.DB_PATH || defaultDb;
// 升级数据源：DB_PATH 未自定义时，运行时库缺失会安全迁移旧文件；可用 LEGACY_DB_PATH 覆盖。
// 自定义 DB_PATH 时默认不自动迁移，避免误读目录里的旧库。
const legacyPath = process.env.LEGACY_DB_PATH !== undefined
  ? (process.env.LEGACY_DB_PATH || null)
  : (dbPath === defaultDb ? defaultLegacy : null);
const port = Number(process.env.PORT || 3038);

const store = new JsonStore(dbPath, seedData, { legacyPath });
const app = createApp(store);
const server = http.createServer(app);

server.listen(port, () => {
  console.log("古船帆装配平与分级缩帆决策 listening on http://localhost:" + port);
  console.log("运行时数据文件：" + dbPath + (legacyPath ? "（旧文件：" + legacyPath + "）" : ""));
});

export { server, store };
