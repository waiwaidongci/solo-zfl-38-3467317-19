// 风帆气动力、合力中心、风压力矩与危险倾角计算。
//
// 模型约定（原型级简化，参数集中可调）：
//   风压     p = 0.5 * ρ * v²  (Pa)，v 取蒲福风级风速下限
//   受风面积 A = Σ 帆面积 * 该档面积系数 * cos(相对风向的收帆投影)
//   横倾力矩 M_h = p * A_eff * z_CE            （z_CE 为合力中心高度）
//   复原力矩 M_r(φ) = Δ · g · GZ(φ)
//   平衡（危险）倾角 φ：M_r(φ) = M_w(φ)，其中 M_w(φ) = M_h · cos(φ)
//   纵向平衡：合力中心纵向位置 x_CE 必须落在 limits.xRange 内
//
// 风向用“相对船首角度”：0° 顶风（受风为零）、90° 横风（投影最大、最危险）、
// 180° 顺风。收帆投影只影响推力/横倾方向，原型里用 |sin θ| 作为横风分量、
// 1 − |cos θ| 的柔和投影作为有效受风投影。

import { BEAUFORT } from "./domain.js";

export const G = 9.81;
export const AIR_DENSITY = 1.225;
export const GUST_FACTOR = 1.3;   // 阵风系数：决策按阵风上限校核
export const SAFETY_FACTOR = 1.5;  // 若登记册未给 limits.safetyFactor 时的默认值

export function windSpeed(beaufort) {
  return BEAUFORT[beaufort].min;
}

export function windPressure(beaufort, gust = GUST_FACTOR) {
  const v = windSpeed(beaufort) * gust;
  return 0.5 * AIR_DENSITY * v * v;
}

// 横风分量驱动横倾；纵向分量影响合力中心的纵向投影
export function windComponents(directionDeg) {
  const rad = (directionDeg * Math.PI) / 180;
  return { beam: Math.abs(Math.sin(rad)), head: Math.cos(rad) };
}

// 线性插值复原力臂
export function gzAt(curve, heel) {
  if (heel <= curve[0].heel) return curve[0].arm;
  for (let i = 1; i < curve.length; i++) {
    if (heel <= curve[i].heel) {
      const a = curve[i - 1];
      const b = curve[i];
      const t = (heel - a.heel) / (b.heel - a.heel);
      return a.arm + (b.arm - a.arm) * t;
    }
  }
  return null; // 超出曲线覆盖范围
}

// 当前缩帆档位 -> 每面帆的状态
export function sailStates(rig, levels) {
  return rig.sails.map((s) => {
    const level = levels[s.id] ?? 0;
    const reef = s.reefs.find((r) => r.level === level) || s.reefs[0];
    const shift = reef.centroidShift || { x: 0, z: 0 };
    const area = s.area * reef.areaFactor;
    return {
      sailId: s.id,
      name: s.name,
      level: reef.level,
      areaFactor: reef.areaFactor,
      area,
      centroid: {
        x: s.centroid.x + (shift.x || 0),
        y: s.centroid.y,
        z: s.centroid.z + (shift.z || 0),
      },
    };
  });
}

// 合力中心（按有效受风面积加权）与总力矩。
export function forceCenter(rig, levels, directionDeg) {
  const { beam } = windComponents(directionDeg);
  const states = sailStates(rig, levels);
  let areaSum = 0;
  let xA = 0;
  let zA = 0;
  for (const st of states) {
    const aEff = st.area; // 各帆相对风向相同，投影系数在汇总时统一处理
    areaSum += aEff;
    xA += st.centroid.x * aEff;
    zA += st.centroid.z * aEff;
  }
  const areaProjected = areaSum * beam; // 横风投影面积
  return {
    states,
    area: areaSum,
    areaProjected,
    x: areaSum === 0 ? 0 : xA / areaSum,
    z: areaSum === 0 ? 0 : zA / areaSum,
    beam,
  };
}

// 在给定风级/风向/缩帆档位下评估船舶状态
export function evaluate(rig, levels, beaufort, directionDeg, opts = {}) {
  const gust = opts.gust ?? GUST_FACTOR;
  const sf = rig.limits.safetyFactor || SAFETY_FACTOR;
  const fc = forceCenter(rig, levels, directionDeg);
  const p = windPressure(beaufort, gust);
  const force = p * fc.areaProjected;          // 横向风力 N
  const momentHeel = force * fc.z;             // 正浮时风压力矩 N·m
  const Δ = rig.displacement;
  const danger = rig.limits.dangerHeel;
  const [xMin, xMax] = rig.limits.xRange;

  let heel = 0;
  let found = false;
  const mrAt = (phi) => {
    const arm = gzAt(rig.rightingCurve, phi);
    return arm === null ? null : Δ * G * arm;
  };
  const mwAt = (phi) => momentHeel * Math.cos((phi * Math.PI) / 180);
  const fAt = (phi) => {
    const mr = mrAt(phi);
    return mr === null ? null : mr - mwAt(phi);
  };
  const noHeelMoment = !(fc.areaProjected > 0 && momentHeel > 0);
  let capsizing = false;
  if (!noHeelMoment) {
    // f(0) = -Mh < 0（GZ 过原点）；首个由负转正的交叉点即稳定平衡倾角。
    // 若到危险角仍未转正，则不存在危险角之前的稳定平衡 -> 倾覆无解。
    const step = 0.25;
    let prev = 0;
    for (let phi = step; phi <= danger + 1e-9; phi += step) {
      const f = fAt(Math.min(phi, danger));
      if (f === null) break;
      if (f >= 0) {
        let lo = prev;
        let hi = Math.min(phi, danger);
        for (let k = 0; k < 30; k++) {
          const mid = (lo + hi) / 2;
          if (fAt(mid) >= 0) hi = mid;
          else lo = mid;
        }
        heel = (lo + hi) / 2;
        found = true;
        break;
      }
      prev = Math.min(phi, danger);
    }
    if (!found) capsizing = true;
  }

  const mrDanger = mrAt(danger);
  const mwZero = momentHeel; // 正浮风压力矩
  const marginAtDanger = (mrDanger === null || mwAt(danger) <= 1e-9) ? null : mrDanger / mwAt(danger);
  const withinX = fc.x >= xMin - 1e-9 && fc.x <= xMax + 1e-9;

  // 安全判据（全部满足才安全）：
  //  1) 危险角之前存在稳定平衡倾角，且严格小于危险倾角（留 0.25° 容差）
  //  2) 危险倾角处复原力矩 ≥ 安全系数 × 该角风压力矩
  //  3) 合力中心纵向位置在平衡范围内
  const notes = [];
  const reasons = [];
  if (noHeelMoment) notes.push("顶风或全收帆，无横向受风");
  if (capsizing) {
    reasons.push(`直至危险倾角 ${danger}° 仍无稳定平衡，持续倾侧（正浮风压力矩 ${Math.round(mwZero)} N·m 超过复原能力）`);
  } else if (found && heel >= danger - 0.25) {
    reasons.push(`平衡倾角 ${heel.toFixed(1)}° 已达危险倾角 ${danger}°`);
  }
  if (marginAtDanger !== null && marginAtDanger < sf) {
    reasons.push(`危险倾角处复原力裕度 ${marginAtDanger.toFixed(2)} 低于安全系数 ${sf}`);
  }
  if (!withinX) {
    const side = fc.x < xMin ? "偏后" : "偏前";
    reasons.push(`合力中心纵向 ${fc.x.toFixed(2)}m ${side}，超出平衡范围 [${xMin}, ${xMax}]m`);
  }
  if (mrDanger === null) {
    reasons.push("复原力曲线未覆盖危险倾角");
  }

  return {
    wind: { beaufort, direction: directionDeg, speed: windSpeed(beaufort), pressure: p, gust },
    forceCenter: { x: fc.x, z: fc.z, area: fc.area, areaProjected: fc.areaProjected, beam: fc.beam },
    sailStates: fc.states,
    moment: { windHeel: momentHeel, rightingDanger: mrDanger, marginAtDanger },
    heel: { equilibrium: found ? heel : (noHeelMoment ? 0 : null), danger, reachesDanger: capsizing },
    longitudinal: { x: fc.x, min: xMin, max: xMax, within: withinX },
    safe: reasons.length === 0,
    reasons,
    notes,
  };
}

// 包络数据：各风级（0..12）在给定档位/风向下的评估，供前端画安全包络
export function envelope(rig, levels, directionDeg, opts = {}) {
  const points = [];
  for (let b = 0; b <= 12; b++) {
    const e = evaluate(rig, levels, b, directionDeg, opts);
    points.push({
      beaufort: b,
      pressure: e.wind.pressure,
      heel: e.heel.equilibrium,
      safe: e.safe,
      marginAtDanger: e.moment.marginAtDanger,
      moment: e.moment.windHeel,
    });
  }
  return points;
}
