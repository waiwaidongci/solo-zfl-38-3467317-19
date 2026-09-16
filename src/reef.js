// 分级缩帆决策：
// 在“每面帆只能从当前档位逐级加深”的前提下，枚举所有档位组合，
// 找出满足复原力（危险倾角/安全系数）与纵向平衡的最小缩帆方案，
// 并给出最大安全风级、原因与下一步作业建议。

import { ValidationError } from "./domain.js";
import { evaluate, envelope } from "./physics.js";

const MAX_COMBINATIONS = 50000;

export function normalizeLevels(rig, levels = {}) {
  const out = {};
  for (const s of rig.sails) {
    const v = levels[s.id];
    if (v === undefined || v === null) {
      out[s.id] = 0;
    } else if (!Number.isInteger(v) || !s.reefs.some((r) => r.level === v)) {
      throw new ValidationError([{ code: "REEF_LEVEL_INVALID", path: `levels.${s.id}`, message: `${s.name} 的当前档位 ${v} 不在登记的缩帆档内` }]);
    } else {
      out[s.id] = v;
    }
  }
  return out;
}

function allCombinations(rig, currentLevels) {
  const sails = rig.sails;
  const combos = [];
  const counts = sails.map((s) => s.reefs.length);
  const total = counts.reduce((a, b) => a * b, 1);
  if (total > MAX_COMBINATIONS) {
    throw new ValidationError([{ code: "COMBINATION_TOO_LARGE", path: "sails", message: `缩帆组合空间 ${total} 超过上限 ${MAX_COMBINATIONS}，请细化登记或分批决策` }]);
  }
  const cur = sails.map((s) => currentLevels[s.id]);
  const rec = (i, acc) => {
    if (i === sails.length) {
      combos.push(acc.slice());
      return;
    }
    // 只允许从当前档位继续加深（升帆/降档由单独作业处理）
    for (let l = cur[i]; l < counts[i]; l++) {
      acc.push(l);
      rec(i + 1, acc);
      acc.pop();
    }
  };
  rec(0, []);
  return combos;
}

function comboToLevels(rig, tuple) {
  const levels = {};
  rig.sails.forEach((s, i) => { levels[s.id] = tuple[i]; });
  return levels;
}

function keptAreaFraction(rig, levels) {
  let full = 0;
  let kept = 0;
  for (const s of rig.sails) {
    full += s.area;
    const reef = s.reefs.find((r) => r.level === levels[s.id]);
    kept += s.area * reef.areaFactor;
  }
  return { kept, full, fraction: full === 0 ? 0 : kept / full };
}

// 连续安全前缀中的最高风级（纵向失衡等与风力无关的失败会使所有风级都不安全）
export function maxSafeBeaufort(rig, levels, direction, opts) {
  const env = envelope(rig, levels, direction, opts);
  let last = -1;
  for (const p of env) {
    if (p.safe) last = p.beaufort;
    else break;
  }
  return { max: last < 0 ? null : last, envelope: env };
}

export function decide(rig, wind, inputLevels = {}, opts = {}) {
  const current = normalizeLevels(rig, inputLevels);
  const { beaufort, direction } = wind;

  const curEval = evaluate(rig, current, beaufort, direction, opts);
  const curMax = maxSafeBeaufort(rig, current, direction, opts);

  const combos = allCombinations(rig, current)
    .map((tuple) => {
      const levels = comboToLevels(rig, tuple);
      const increments = rig.sails.reduce((n, s, i) => n + (tuple[i] - current[s.id]), 0);
      const area = keptAreaFraction(rig, levels);
      return { tuple, levels, increments, kept: area.kept, fraction: area.fraction };
    })
    .sort((a, b) => {
      if (a.increments !== b.increments) return a.increments - b.increments;   // 最少作业档数（最小缩帆）
      if (a.kept !== b.kept) return b.kept - a.kept;                           // 保留最多帆面积
      if (a.fraction !== b.fraction) return b.fraction - a.fraction;
      const ta = a.tuple.join(",");
      const tb = b.tuple.join(",");
      return ta < tb ? -1 : ta > tb ? 1 : 0;                                   // 确定性兜底顺序
    });

  let solution = null;
  if (!curEval.safe) {
    for (const c of combos) {
      const e = evaluate(rig, c.levels, beaufort, direction, opts);
      if (e.safe) {
        solution = { ...c, evaluation: e };
        break;
      }
    }
  }

  // 全收帆状态用于解释“无解”
  const deepestTuple = rig.sails.map((s) => s.reefs.length - 1);
  const deepestLevels = comboToLevels(rig, deepestTuple);
  const deepestEval = evaluate(rig, deepestLevels, beaufort, direction, opts);

  let maxSafe = null;
  if (solution) {
    maxSafe = maxSafeBeaufort(rig, solution.levels, direction, opts);
  }

  // 结论、原因与下一步
  let feasible;
  let status;
  let reason;
  let nextStep;
  const firstMoves = [];

  if (curEval.safe) {
    status = "safe";
    feasible = true;
    reason = `当前缩帆档位在 ${beaufort} 级风下满足复原力与纵向平衡要求`;
    nextStep = curMax.max !== null && curMax.max < 12
      ? `保持现档位；风力升至 ${curMax.max + 1} 级前先收一档，现档位最高可承受 ${curMax.max} 级`
      : "保持现档位，按正常更值守望";
  } else if (solution) {
    status = "reef_required";
    feasible = true;
    for (const s of rig.sails) {
      const d = solution.levels[s.id] - current[s.id];
      if (d > 0) firstMoves.push({ sailId: s.id, name: s.name, from: current[s.id], to: current[s.id] + 1, depth: d });
    }
    reason = `当前档位不安全：${curEval.reasons.join("；")}。收至 ${solution.increments} 档后各项约束恢复`;
    const first = firstMoves.map((m) => `${m.name} ${m.from}→${m.to} 档`).join("、");
    nextStep = `第一步（逐级）：${first}；该方案最高安全风级 ${maxSafe.max} 级` +
      (solution.increments > firstMoves.length ? `，共需 ${solution.increments} 个档距，逐档完成` : "");
  } else {
    status = "infeasible";
    feasible = false;
    reason = `即便全部帆收至最深档仍不安全：${deepestEval.reasons.join("；")}`;
    const xFail = deepestEval.reasons.some((r) => r.includes("纵向"));
    nextStep = xFail
      ? "纵向平衡无法靠缩帆修正：应调整压载/货物纵向分布或改变受风航向，再重新评估"
      : "应立即驶离避风、改顺风航向减小横风分量，并复核压载与复原力曲线登记";
  }

  return {
    code: rig.code,
    request: { beaufort, direction },
    status,
    feasible,
    current: {
      levels: current,
      evaluation: curEval,
      maxSafeBeaufort: curMax.max,
      envelope: curMax.envelope,
    },
    solution: solution && {
      levels: solution.levels,
      increments: solution.increments,
      keptAreaFraction: Number(solution.fraction.toFixed(4)),
      evaluation: solution.evaluation,
      maxSafeBeaufort: maxSafe.max,
      envelope: maxSafe.envelope,
      firstMoves,
    },
    deepest: { levels: deepestLevels, evaluation: deepestEval },
    reason,
    nextStep,
  };
}
