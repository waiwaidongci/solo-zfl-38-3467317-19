import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { JsonStore } from "./src/store.js";
import { seedData } from "./src/seed.js";
import { createApp } from "./src/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "data", "model-rigging-calibration.json");
const port = Number(process.env.PORT || 3038);

const store = new JsonStore(dbPath, seedData);
const app = createApp(store);
const server = http.createServer(app);

server.listen(port, () => {
  console.log("古船帆装配平与分级缩帆决策 listening on http://localhost:" + port);
  console.log("数据文件：" + dbPath);
});

export { server, store };
