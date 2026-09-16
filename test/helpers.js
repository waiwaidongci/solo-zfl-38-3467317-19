import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonStore } from "../src/store.js";
import { createApp } from "../src/app.js";
import { seedData } from "../src/seed.js";

export async function tempDbFile(label = "rig") {
  const dir = await mkdtemp(path.join(os.tmpdir(), `sail-${label}-`));
  return { file: path.join(dir, "db.json"), dir };
}

export async function cleanup(dir) { await rm(dir, { recursive: true, force: true }); }

export async function startServer(file) {
  const store = new JsonStore(file, seedData);
  const server = http.createServer(createApp(store));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, store, stop: () => new Promise((r) => server.close(r)) };
}

export async function api(base, route, options = {}) {
  const res = await fetch(base + route, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data };
}

// 合法帆装基底，各测试按需覆盖字段
export function validRigInput(over = {}) {
  return {
    code: "T-1",
    name: "测试船",
    displacement: 60000,
    sails: [
      {
        id: "a", name: "前帆", area: 40, centroid: { x: 6, y: 0, z: 9 },
        reefs: [
          { level: 0, name: "满帆", areaFactor: 1 },
          { level: 1, name: "一档", areaFactor: 0.7, centroidShift: { z: -0.8 } },
          { level: 2, name: "二档", areaFactor: 0.35, centroidShift: { z: -1.6 } },
        ],
      },
      {
        id: "b", name: "主帆", area: 60, centroid: { x: 0, y: 0, z: 12 },
        reefs: [
          { level: 0, areaFactor: 1 },
          { level: 1, areaFactor: 0.65, centroidShift: { z: -1 } },
          { level: 2, areaFactor: 0.3, centroidShift: { z: -2 } },
        ],
      },
    ],
    rightingCurve: [
      { heel: 0, arm: 0 }, { heel: 10, arm: 0.45 }, { heel: 20, arm: 0.58 },
      { heel: 30, arm: 0.5 }, { heel: 40, arm: 0.32 }, { heel: 60, arm: 0.06 },
      { heel: 90, arm: 0 },
    ],
    limits: { dangerHeel: 40, xRange: [-6, 6], safetyFactor: 1.5 },
    ...over,
  };
}
