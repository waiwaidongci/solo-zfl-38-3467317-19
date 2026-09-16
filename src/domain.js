// 帆装配平领域模型与严格校验。
// 任何不合法的登记（数据缺失、曲线乱序、重复档、档位跳号）都抛 ValidationError。

export class ValidationError extends Error {
  constructor(errors) {
    super(errors.map((e) => `${e.code} ${e.path ? "(" + e.path + ")" : ""}: ${e.message}`).join("; "));
    this.name = "ValidationError";
    this.errors = errors;
  }
}

export class ConflictError extends Error {
  constructor(code, message, currentVersion) {
    super(message);
    this.name = "ConflictError";
    this.code = code;
    this.currentVersion = currentVersion;
  }
}

export class NotFoundError extends Error {
  constructor(code = "not_found", message = "资源不存在") {
    super(message);
    this.name = "NotFoundError";
    this.code = code;
  }
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function err(errors, code, path, message) {
  errors.push({ code, path, message });
}

// 蒲福风级表（风速下限 m/s），0..12
export const BEAUFORT = [
  { level: 0, name: "无风", min: 0.0 },
  { level: 1, name: "软风", min: 0.3 },
  { level: 2, name: "轻风", min: 1.6 },
  { level: 3, name: "微风", min: 3.4 },
  { level: 4, name: "和风", min: 5.5 },
  { level: 5, name: "清风", min: 8.0 },
  { level: 6, name: "强风", min: 10.8 },
  { level: 7, name: "疾风", min: 13.9 },
  { level: 8, name: "大风", min: 17.2 },
  { level: 9, name: "烈风", min: 20.8 },
  { level: 10, name: "狂风", min: 24.5 },
  { level: 11, name: "暴风", min: 28.5 },
  { level: 12, name: "飓风", min: 32.7 },
];

export function validateWind(input) {
  const errors = [];
  let beaufort = input?.beaufort;
  if (beaufort === undefined || beaufort === null) {
    err(errors, "WIND_MISSING", "beaufort", "缺少风级");
  } else {
    beaufort = Number(beaufort);
    if (!Number.isInteger(beaufort) || beaufort < 0 || beaufort > 12) {
      err(errors, "WIND_BEAUFORT_INVALID", "beaufort", "风级必须是 0..12 的整数");
    }
  }
  let direction = input?.windDirection;
  if (direction === undefined || direction === null || direction === "") {
    err(errors, "WIND_MISSING", "windDirection", "缺少风向（相对船首的度数，0=顶风 90=横风 180=顺风）");
  } else {
    direction = Number(direction);
    if (!isNum(direction)) err(errors, "WIND_DIRECTION_INVALID", "windDirection", "风向必须是数字");
    else direction = ((direction % 360) + 360) % 360;
  }
  if (errors.length) throw new ValidationError(errors);
  return { beaufort, direction };
}

function validateSail(sail, errors) {
  const path = `sails[${sail?.id ?? "?"}]`;
  if (!sail || typeof sail !== "object") {
    err(errors, "SAIL_INVALID", path, "帆面必须是对象");
    return null;
  }
  if (!sail.id || typeof sail.id !== "string") {
    err(errors, "SAIL_ID_MISSING", `${path}.id`, "帆面缺少唯一编号");
  }
  if (!isNum(sail.area) || sail.area <= 0) {
    err(errors, "SAIL_AREA_MISSING", `${path}.area`, "帆面面积必须是正数");
  }
  const c = sail.centroid;
  if (!c || typeof c !== "object") {
    err(errors, "SAIL_CENTROID_MISSING", `${path}.centroid`, "帆面缺少形心 {x,y,z}");
  } else {
    if (!isNum(c.x)) err(errors, "SAIL_CENTROID_MISSING", `${path}.centroid.x`, "形心纵向坐标 x 缺失或非数字");
    if (!isNum(c.z)) err(errors, "SAIL_CENTROID_MISSING", `${path}.centroid.z`, "形心高度 z 缺失或非数字");
    if (c.y !== undefined && !isNum(c.y)) err(errors, "SAIL_CENTROID_INVALID", `${path}.centroid.y`, "形心横向坐标 y 非数字");
  }
  if (!Array.isArray(sail.reefs) || sail.reefs.length === 0) {
    err(errors, "REEF_MISSING", `${path}.reefs`, "帆面缺少缩帆档");
    return null;
  }
  const seen = new Set();
  const reefs = [];
  for (const [i, r] of sail.reefs.entries()) {
    const rp = `${path}.reefs[${i}]`;
    if (!r || typeof r !== "object") {
      err(errors, "REEF_INVALID", rp, "缩帆档必须是对象");
      continue;
    }
    if (!Number.isInteger(r.level)) {
      err(errors, "REEF_LEVEL_INVALID", `${rp}.level`, "档位必须是整数");
      continue;
    }
    // 重复档
    if (seen.has(r.level)) {
      err(errors, "REEF_DUPLICATE", `${rp}.level`, `档位 ${r.level} 重复登记`);
    }
    seen.add(r.level);
    if (!isNum(r.areaFactor) || r.areaFactor < 0 || r.areaFactor > 1) {
      err(errors, "REEF_FACTOR_INVALID", `${rp}.areaFactor`, "缩帆面积系数必须在 0..1");
    }
    const shift = r.centroidShift || {};
    if (shift.x !== undefined && !isNum(shift.x)) err(errors, "REEF_SHIFT_INVALID", `${rp}.centroidShift.x`, "形心纵向偏移非数字");
    if (shift.z !== undefined && !isNum(shift.z)) err(errors, "REEF_SHIFT_INVALID", `${rp}.centroidShift.z`, "形心高度偏移非数字");
    reefs.push({
      level: r.level,
      name: typeof r.name === "string" && r.name ? r.name : `${r.level} 档`,
      areaFactor: r.areaFactor,
      centroidShift: { x: shift.x || 0, z: shift.z || 0 },
    });
  }
  // 档位必须从 0 开始逐级连续（非法跳号/缺档）
  const levels = [...seen].sort((a, b) => a - b);
  if (levels.length && levels[0] !== 0) {
    err(errors, "REEF_GAP", `${path}.reefs`, "缩帆档必须从 0 档（满帆）开始");
  }
  for (const lvl of levels) {
    if (!seen.has(lvl) || lvl >= levels.length) {
      err(errors, "REEF_GAP", `${path}.reefs`, "缩帆档必须连续，不允许跳档");
      break;
    }
  }
  if (levels.some((l, i) => l !== i)) {
    err(errors, "REEF_GAP", `${path}.reefs`, "缩帆档必须恰好为 0,1,2… 不允许跳档");
  }
  reefs.sort((a, b) => a.level - b.level);
  // 0 档必须是满帆，面积系数只允许随档位递减
  if (reefs.length && reefs[0].level === 0 && reefs[0].areaFactor !== 1) {
    err(errors, "REEF_FACTOR_INVALID", `${path}.reefs[0].areaFactor`, "0 档必须为满帆（面积系数 1）");
  }
  for (let i = 1; i < reefs.length; i++) {
    if (reefs[i].areaFactor >= reefs[i - 1].areaFactor) {
      err(errors, "REEF_FACTOR_INVALID", `${path}.reefs[${i}].areaFactor`, "缩帆后面积系数必须严格减小（收档必须真正减帆）");
    }
  }
  if (errors.some((e) => e.path.startsWith(path))) return null;
  return {
    id: sail.id,
    name: typeof sail.name === "string" && sail.name ? sail.name : sail.id,
    area: sail.area,
    centroid: { x: c.x, y: isNum(c.y) ? c.y : 0, z: c.z },
    reefs,
  };
}

// 登记/替换整套帆装配平。返回规范化后的 rig（不含 version/updatedAt，由存储层赋值）。
export function validateRig(input) {
  const errors = [];
  if (!input || typeof input !== "object") {
    throw new ValidationError([{ code: "RIG_INVALID", path: "", message: "请求体必须是帆装对象" }]);
  }
  if (!input.code || typeof input.code !== "string") {
    err(errors, "RIG_CODE_MISSING", "code", "船只缺少编号");
  }
  if (!isNum(input.displacement) || input.displacement <= 0) {
    err(errors, "RIG_DISPLACEMENT_MISSING", "displacement", "排水量必须是正数（kg）");
  }
  if (!Array.isArray(input.sails) || input.sails.length === 0) {
    err(errors, "RIG_SAILS_MISSING", "sails", "至少登记一面帆");
  }
  const sails = [];
  const sailIds = new Set();
  for (const s of input.sails || []) {
    const norm = validateSail(s, errors);
    if (norm) {
      if (sailIds.has(norm.id)) err(errors, "SAIL_DUPLICATE", `sails.${norm.id}`, "帆面编号重复");
      sailIds.add(norm.id);
      sails.push(norm);
    }
  }
  // 复原力曲线：点数足够、倾角严格升序、覆盖危险倾角
  const curve = [];
  if (!Array.isArray(input.rightingCurve) || input.rightingCurve.length < 2) {
    err(errors, "CURVE_MISSING", "rightingCurve", "复原力曲线至少需要 2 个点");
  } else {
    for (const [i, p] of input.rightingCurve.entries()) {
      if (!p || !isNum(p.heel) || !isNum(p.arm)) {
        err(errors, "CURVE_POINT_INVALID", `rightingCurve[${i}]`, "曲线点必须是 {heel, arm} 数字对");
        continue;
      }
      curve.push({ heel: p.heel, arm: p.arm });
    }
    for (let i = 1; i < curve.length; i++) {
      if (curve[i].heel <= curve[i - 1].heel) {
        err(errors, "CURVE_UNORDERED", `rightingCurve[${i}].heel`, "复原力曲线倾角必须严格升序，发现乱序");
        break;
      }
    }
    if (curve.length && curve[0].heel !== 0) {
      err(errors, "CURVE_UNORDERED", "rightingCurve[0].heel", "复原力曲线必须从倾角 0° 开始");
    }
    if (curve.length && Math.abs(curve[0].arm) > 1e-9) {
      err(errors, "CURVE_ORIGIN", "rightingCurve[0].arm", "倾角 0° 处复原力臂必须为 0（GZ 曲线须过原点）");
    }
  }
  const limits = input.limits || {};
  if (!isNum(limits.dangerHeel) || limits.dangerHeel <= 0 || limits.dangerHeel >= 180) {
    err(errors, "LIMIT_DANGER_INVALID", "limits.dangerHeel", "危险倾角必须在 0..180 度之间");
  }
  if (!Array.isArray(limits.xRange) || limits.xRange.length !== 2 ||
      !isNum(limits.xRange[0]) || !isNum(limits.xRange[1]) ||
      limits.xRange[0] >= limits.xRange[1]) {
    err(errors, "LIMIT_XRANGE_INVALID", "limits.xRange", "纵向平衡范围必须是 [后限, 前限] 且后限 < 前限");
  }
  if (!isNum(limits.safetyFactor) || limits.safetyFactor < 1) {
    err(errors, "LIMIT_FACTOR_INVALID", "limits.safetyFactor", "复原力安全系数必须 ≥ 1");
  }
  if (errors.length) throw new ValidationError(errors);
  if (curve[curve.length - 1].heel < limits.dangerHeel) {
    throw new ValidationError([{
      code: "CURVE_RANGE",
      path: "rightingCurve",
      message: `复原力曲线只覆盖到 ${curve[curve.length - 1].heel}°，未达到危险倾角 ${limits.dangerHeel}°`,
    }]);
  }
  return {
    code: input.code,
    name: typeof input.name === "string" ? input.name : input.code,
    displacement: input.displacement,
    sails,
    rightingCurve: curve,
    limits: {
      dangerHeel: limits.dangerHeel,
      xRange: [limits.xRange[0], limits.xRange[1]],
      safetyFactor: limits.safetyFactor,
    },
  };
}

// 更新帆装定义时，把旧 currentLevels 迁移到新定义上。
//   - clamp（默认，确定性且可追溯）：
//       * 超出新档数范围的旧档 -> 钳到新的末档；
//       * 新定义中新增的帆（复用新编号也算新帆）-> 0 档（满帆）；
//       * 已从定义中移除的帆 -> 删除其档位记录；
//       所有实际迁移都记录在 returned.migrations 中，供审计日志与响应。
//   - reject：发现任何越界旧档或“仍在收帆状态的帆被移除”即抛 ValidationError，整体拒绝。
// 身份按帆面编号（sailId）认定：编号被复用时视为同一面帆的定义变更，按新档数钳制。
export function migrateLevels(oldRig, newRig, policy = "clamp") {
  if (policy !== "clamp" && policy !== "reject") {
    throw new ValidationError([{ code: "LEVEL_POLICY_INVALID", path: "levelPolicy", message: `未知档位迁移策略 ${policy}` }]);
  }
  const errors = [];
  const oldLevels = (oldRig && oldRig.currentLevels) || {};
  const oldIds = new Set(((oldRig && oldRig.sails) || []).map((s) => s.id));
  const levels = {};
  const migrations = [];
  const newIds = new Set(newRig.sails.map((s) => s.id));
  const maxOf = (id) => newRig.sails.find((s) => s.id === id).reefs.length - 1;

  for (const [id, oldLevel] of Object.entries(oldLevels)) {
    if (!newIds.has(id)) {
      if (oldLevel > 0 && policy === "reject") {
        err(errors, "LEVEL_SAIL_REMOVED", `currentLevels.${id}`,
          `帆面 ${id} 已收至 ${oldLevel} 档，但新定义移除了该帆：拒绝更新（改用 clamp 可移除并记录）`);
      } else {
        // 无论是否在收帆状态，移除帆面都留下可追溯记录
        migrations.push({ sailId: id, action: "removed", from: oldLevel, to: null, reason: "帆面已从登记中移除，删除其档位" });
      }
      continue;
    }
    const max = maxOf(id);
    if (!Number.isInteger(oldLevel) || oldLevel < 0 || oldLevel > max) {
      if (policy === "reject") {
        err(errors, "LEVEL_OUT_OF_RANGE", `currentLevels.${id}`,
          `帆面 ${id} 当前 ${oldLevel} 档超出新定义的 0..${max} 档：拒绝更新`);
        continue;
      }
      const clamped = Math.max(0, Math.min(Number.isInteger(oldLevel) ? oldLevel : 0, max));
      levels[id] = clamped;
      migrations.push({
        sailId: id, action: "clamped", from: oldLevel, to: clamped,
        reason: `旧档位 ${oldLevel} 超出新定义 0..${max}，钳至末档 ${clamped}`,
      });
    } else {
      levels[id] = oldLevel;
    }
  }
  for (const s of newRig.sails) {
    if (!(s.id in levels)) {
      levels[s.id] = 0;
      if (!oldIds.has(s.id)) {
        migrations.push({ sailId: s.id, action: "added", from: null, to: 0, reason: "新增帆面，初始化为满帆 0 档" });
      }
    }
  }
  if (errors.length) throw new ValidationError(errors);
  return { levels, migrations };
}

// 校验“逐级调整”的作业指令：每面帆一次只能变动一档。
export function validateMoves(rig, currentLevels, moves) {
  const errors = [];
  if (!Array.isArray(moves) || moves.length === 0) {
    err(errors, "MOVE_MISSING", "moves", "缺少调整指令");
  }
  const bySail = new Map();
  for (const [i, m] of (moves || []).entries()) {
    const sail = rig.sails.find((s) => s.id === m?.sailId);
    if (!sail) {
      err(errors, "SAIL_NOT_FOUND", `moves[${i}].sailId`, `帆面 ${m?.sailId} 不在登记册中`);
      continue;
    }
    if (!Number.isInteger(m.toLevel) || !sail.reefs.some((r) => r.level === m.toLevel)) {
      err(errors, "REEF_LEVEL_INVALID", `moves[${i}].toLevel`, "目标档位不在登记的缩帆档内");
      continue;
    }
    const from = currentLevels[m.sailId] ?? 0;
    if (Math.abs(m.toLevel - from) > 1) {
      err(errors, "REEF_JUMP_ILLEGAL", `moves[${i}]`,
        `${sail.name} 当前 ${from} 档，要求一次跳到 ${m.toLevel} 档：档位只能逐级调整`);
    }
    if (bySail.has(m.sailId)) {
      err(errors, "MOVE_DUPLICATE", `moves[${i}].sailId`, "同一面帆在一次作业中出现多次");
    }
    bySail.set(m.sailId, m);
  }
  if (errors.length) throw new ValidationError(errors);
  return moves;
}
