// 种子数据：两艘演示船 + 原型交付快照中的帆索校准台账。
// FC-001 福船：满帆安全到 5 级，6 级横风需要降档，约 9 级以上即使深收帆也无解。
// SD-002 浅吃水沙船：复原力弱，7 级横风即无解，用于演示危险路径。
//
// 旧台账来自不可变交付快照 data/delivery/legacy-snapshot.json；
// 该文件永不被写入，每次种子都深拷贝，运行时库与测试库的任何变更都不会回灌快照。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(__dirname, "..", "data", "delivery", "legacy-snapshot.json");

let snapshotCache = null;
export function legacySnapshot() {
  if (!snapshotCache) {
    snapshotCache = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  }
  return structuredClone(snapshotCache);
}


const fore = {
  id: "fore", name: "前桅帆", area: 42, centroid: { x: 8, y: 0, z: 9 },
  reefs: [
    { level: 0, name: "满帆", areaFactor: 1.0 },
    { level: 1, name: "收一档", areaFactor: 0.72, centroidShift: { x: 0, z: -0.8 } },
    { level: 2, name: "收二档", areaFactor: 0.42, centroidShift: { x: 0, z: -1.6 } },
    { level: 3, name: "收三档", areaFactor: 0.12, centroidShift: { x: 0, z: -2.4 } },
  ],
};
const mainSail = {
  id: "main", name: "主桅帆", area: 64, centroid: { x: 0, y: 0, z: 12 },
  reefs: [
    { level: 0, name: "满帆", areaFactor: 1.0 },
    { level: 1, name: "收一档", areaFactor: 0.7, centroidShift: { x: 0, z: -1.1 } },
    { level: 2, name: "收二档", areaFactor: 0.38, centroidShift: { x: 0, z: -2.2 } },
    { level: 3, name: "收三档", areaFactor: 0.1, centroidShift: { x: 0, z: -3.3 } },
  ],
};
const mizzen = {
  id: "mizzen", name: "尾桅帆", area: 28, centroid: { x: -9, y: 0, z: 8 },
  reefs: [
    { level: 0, name: "满帆", areaFactor: 1.0 },
    { level: 1, name: "收一档", areaFactor: 0.68, centroidShift: { x: 0, z: -0.7 } },
    { level: 2, name: "收二档", areaFactor: 0.35, centroidShift: { x: 0, z: -1.4 } },
    { level: 3, name: "收三档", areaFactor: 0.08, centroidShift: { x: 0, z: -2.0 } },
  ],
};

const goodCurve = [
  { heel: 0, arm: 0 }, { heel: 10, arm: 0.42 }, { heel: 20, arm: 0.55 },
  { heel: 30, arm: 0.48 }, { heel: 40, arm: 0.3 }, { heel: 60, arm: 0.05 },
  { heel: 90, arm: 0 },
];
const weakCurve = [
  { heel: 0, arm: 0 }, { heel: 10, arm: 0.18 }, { heel: 20, arm: 0.14 },
  { heel: 30, arm: 0.07 }, { heel: 40, arm: 0.03 }, { heel: 60, arm: 0 },
  { heel: 90, arm: -0.05 },
];

export function seedData() {
  const mkRig = (code, name, displacement, curve) => ({
    code,
    name,
    displacement,
    sails: [fore, mainSail, mizzen],
    rightingCurve: curve,
    limits: { dangerHeel: 40, xRange: [-6, 6], safetyFactor: 1.5 },
  });
  return {
    rigs: [
      {
        ...mkRig("FC-001", "福船（1:48 复原模型）", 60000, goodCurve),
        version: 1,
        currentLevels: { fore: 0, main: 0, mizzen: 0 },
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        createdBy: "seed",
        logs: [],
      },
      {
        ...mkRig("SD-002", "浅吃水沙船（复原力偏弱）", 55000, weakCurve),
        version: 1,
        currentLevels: { fore: 0, main: 0, mizzen: 0 },
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
        createdBy: "seed",
        logs: [],
      },
    ],
    // 旧台账：从不可变交付快照深拷贝（保留原始编号、两条任务与模型级日志）
    items: legacySnapshot().items,
  };
}

export { SNAPSHOT_PATH };
