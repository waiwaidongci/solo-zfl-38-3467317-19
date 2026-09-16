// 页面：帆面中心图、安全包络图、缩帆建议与逐级作业；下方保留旧版帆索校准。
// 浏览器端脚本不使用模板字符串（避免与外层模板冲突），全部用字符串拼接。

export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>帆装配平与分级缩帆决策</title>
<style>
  :root { --bg:#eef1ea; --panel:#fff; --ink:#1f241d; --muted:#6a7266; --line:#cfd8ca; --accent:#3f6b38; --accent2:#2f5d8a; --warn:#a8442f; --safe:#3f7d4a; --reef:#b5781a; --bad:#a8362f; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif; }
  header { padding:18px 26px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:12px; }
  h1 { margin:0; font-size:23px; } h2 { font-size:16px; margin:0 0 10px; } h3 { font-size:14px; margin:12px 0 6px; }
  main { padding:18px 26px; display:grid; grid-template-columns:330px 1fr; gap:16px; }
  .panel,.card { background:var(--panel); border:1px solid var(--line); border-radius:9px; padding:14px; }
  .stack { display:grid; gap:14px; align-content:start; }
  label { display:block; font-size:12px; color:var(--muted); margin:8px 0 3px; }
  input,select,textarea,button { font:inherit; }
  input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; background:#fff; }
  textarea { min-height:150px; font-family:Menlo,Consolas,monospace; font-size:12px; }
  button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:8px 12px; font-weight:700; cursor:pointer; }
  button.secondary { background:#5d6b5c; } button.blue { background:var(--accent2); }
  button:disabled { background:#aab3a8; cursor:not-allowed; }
  .rigline { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:8px 10px; border:1px solid var(--line); border-radius:7px; margin-bottom:7px; cursor:pointer; background:#fff; }
  .rigline.active { border-color:var(--accent); box-shadow:0 0 0 2px rgba(63,107,56,.18); }
  .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; }
  .banner { border-radius:9px; padding:13px 15px; color:#fff; margin-bottom:12px; }
  .banner.safe { background:var(--safe); } .banner.reef { background:var(--reef); } .banner.bad { background:var(--bad); }
  .banner h2 { color:#fff; margin-bottom:4px; }
  .meta { color:var(--muted); font-size:12px; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .sailrow { display:grid; grid-template-columns:1fr auto auto auto; gap:8px; align-items:center; padding:7px 4px; border-bottom:1px dashed var(--line); font-size:13px; }
  .lvl { font-weight:700; min-width:52px; text-align:center; }
  .lvlbtn { padding:5px 10px; min-width:38px; }
  .err { color:var(--warn); font-size:12px; white-space:pre-wrap; margin-top:6px; }
  .conflict { background:#fbe9e5; border:1px solid var(--bad); color:var(--bad); border-radius:8px; padding:9px 11px; font-size:13px; margin-bottom:10px; display:none; }
  table { border-collapse:collapse; width:100%; font-size:12px; } td,th { border:1px solid var(--line); padding:4px 7px; text-align:right; } th { background:#f3f6f0; }
  svg { width:100%; height:auto; display:block; }
  details { margin-top:16px; border-top:2px solid var(--line); padding-top:10px; }
  summary { cursor:pointer; font-weight:700; padding:8px 0; }
  #toast { position:fixed; right:18px; bottom:18px; background:#222; color:#fff; padding:10px 15px; border-radius:8px; font-size:13px; display:none; }
  @media (max-width:980px){ main{grid-template-columns:1fr;} .grid2{grid-template-columns:1fr;} }
</style>
</head>
<body>
<header>
  <div><h1>帆装配平与分级缩帆决策</h1><div class="meta">登记帆面形心与复原力曲线，按风向风级求最小缩帆方案</div></div>
  <div><span class="pill" id="storeVer"></span> <button class="secondary" id="reload">刷新数据</button></div>
</header>
<main>
  <div class="stack">
    <section class="panel">
      <h2>在册船只</h2>
      <div id="rigList"></div>
    </section>
    <section class="panel">
      <h2>登记 / 更新帆装配平</h2>
      <label>船只（新建请在 JSON 中给唯一 code）</label>
      <select id="regTarget"></select>
      <label>登记数据 JSON（帆面、面积、形心、缩帆档、复原力曲线、限制）</label>
      <textarea id="regJson" spellcheck="false"></textarea>
      <label>更新时旧档位与新档位定义不兼容的处理</label>
      <select id="levelPolicy">
        <option value="clamp" selected>clamp：越界档钳到新末档、新增帆置 0 档、移除帆删档（全部留痕）</option>
        <option value="reject">reject：存在越界档或移除收帆中的帆，整体拒绝更新</option>
      </select>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button id="regSubmit">提交登记（新建）</button>
        <button class="blue" id="regUpdate">按当前版本更新</button>
      </div>
      <div class="err" id="regErr"></div>
    </section>
  </div>

  <div class="stack">
    <div class="conflict" id="conflictBox"></div>
    <section class="panel">
      <div style="display:flex;flex-wrap:wrap;gap:14px;align-items:end">
        <div><label>风级（蒲福）</label><select id="beaufort"></select></div>
        <div style="flex:1;min-width:200px"><label>风向（相对船首：0 顶风 / 90 横风 / 180 顺风）</label>
          <div style="display:flex;gap:8px"><input id="direction" type="number" min="0" max="360" value="90"><select id="dirPreset" style="max-width:110px"><option value="">自定义</option><option value="0">顶风</option><option value="45">侧舷</option><option value="90" selected>横风</option><option value="135">艉舷</option><option value="180">顺风</option></select></div>
        </div>
        <div><button id="evalBtn">评估</button></div>
      </div>
    </section>

    <section class="panel" id="decisionPanel"><div class="meta">请选择船只</div></section>

    <div class="grid2">
      <section class="panel"><h2>帆面中心（侧视图，■ 帆面形心 × 合力中心）</h2><div id="sailPlan"></div></section>
      <section class="panel"><h2>安全包络（各风级平衡倾角 vs 危险倾角）</h2><div id="envelope"></div></section>
    </div>

    <section class="panel">
      <h2>逐级缩帆作业</h2>
      <div class="meta">档位只能逐级调整；多端并发时以版本号冲突保护，后写不会覆盖先写。</div>
      <div id="reefControls" style="margin-top:8px"></div>
      <div style="margin-top:10px;display:flex;gap:8px"><button id="applyFirst" class="blue">按建议执行第一步</button><button class="secondary" id="resetView">重新评估</button></div>
    </section>

    <details>
      <summary>旧版：帆索校准台账</summary>
      <section class="panel" style="margin-top:8px">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">
          <div><label>模型编号</label><input id="mCode" style="min-width:130px"></div>
          <div><label>船型</label><input id="mType" style="min-width:110px"></div>
          <div><label>负责人</label><input id="mOwner" style="min-width:100px"></div>
          <button id="mAdd">新增模型</button>
        </div>
        <div id="mList" style="margin-top:10px"></div>
      </section>
    </details>
  </div>
</main>
<div id="toast"></div>

<script>
"use strict";
var state = { rigs: [], rig: null, detail: null, decision: null, wind: { beaufort: 6, direction: 90 } };

function api(path, options) {
  var opt = options || {};
  if (opt.body) { opt.headers = { "Content-Type": "application/json" }; }
  return fetch(path, opt).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) { var e = new Error(data.error || "请求失败"); e.status = res.status; e.data = data; throw e; }
      return data;
    });
  });
}
function toast(msg, bad) {
  var t = document.getElementById("toast");
  t.textContent = msg; t.style.background = bad ? "#a8362f" : "#222"; t.style.display = "block";
  clearTimeout(t._timer); t._timer = setTimeout(function () { t.style.display = "none"; }, 3200);
}
function el(id) { return document.getElementById(id); }
function fmt(n, d) { if (n === null || n === undefined || !isFinite(n)) return "—"; return Number(n).toFixed(d === undefined ? 2 : d); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

function initWind() {
  var sel = el("beaufort");
  var names = ["无风","软风","轻风","微风","和风","清风","强风","疾风","大风","烈风","狂风","暴风","飓风"];
  var html = "";
  for (var i = 0; i <= 12; i++) html += '<option value="' + i + '"' + (i === 6 ? " selected" : "") + ">" + i + " 级 · " + names[i] + "</option>";
  sel.innerHTML = html;
  sel.onchange = function () { state.wind.beaufort = Number(sel.value); loadDecision(); };
  el("direction").onchange = function () { state.wind.direction = Number(el("direction").value) || 0; loadDecision(); };
  el("dirPreset").onchange = function () { if (el("dirPreset").value !== "") { el("direction").value = el("dirPreset").value; state.wind.direction = Number(el("dirPreset").value); loadDecision(); } };
  el("evalBtn").onclick = loadDecision;
  el("resetView").onclick = loadDecision;
}

function loadRigs(selectCode) {
  return api("/api/rigs").then(function (d) {
    state.rigs = d.rigs;
    var list = "";
    d.rigs.forEach(function (r) {
      var active = state.rig && state.rig.code === r.code;
      list += '<div class="rigline' + (active ? " active" : "") + '" data-code="' + esc(r.code) + '"><div><b>' + esc(r.code) + '</b> ' + esc(r.name) +
        '<div class="meta">v' + r.version + ' · ' + r.sailCount + ' 面帆 · 排水 ' + r.displacement + ' kg</div></div><span class="pill">选择</span></div>';
    });
    el("rigList").innerHTML = list || '<div class="meta">尚无登记船只</div>';
    Array.prototype.forEach.call(document.querySelectorAll(".rigline"), function (node) {
      node.onclick = function () { selectRig(node.getAttribute("data-code")); };
    });
    var reg = '<option value="">— 新建船只 —</option>' + d.rigs.map(function (r) { return '<option value="' + esc(r.code) + '">' + esc(r.code) + " v" + r.version + "</option>"; }).join("");
    el("regTarget").innerHTML = reg;
    if (selectCode) el("regTarget").value = selectCode;
  });
}

function selectRig(code) {
  return api("/api/rigs/" + encodeURIComponent(code)).then(function (d) {
    state.detail = d.rig; state.rig = { code: d.rig.code, name: d.rig.name, version: d.rig.version };
    el("regTarget").value = code;
    fillRegJson(d.rig);
    return loadRigs(code);
  }).then(loadDecision).then(renderReefControls);
}

function fillRegJson(rig) {
  var copy = { code: rig.code, name: rig.name, displacement: rig.displacement, sails: rig.sails, rightingCurve: rig.rightingCurve, limits: rig.limits };
  el("regJson").value = JSON.stringify(copy, null, 2);
}

function loadDecision() {
  if (!state.detail) return Promise.resolve();
  hideConflict();
  var url = "/api/rigs/" + encodeURIComponent(state.detail.code) + "/decision?beaufort=" + state.wind.beaufort + "&direction=" + state.wind.direction;
  return api(url).then(function (d) {
    state.decision = d.decision; state.detail.version = d.version;
    renderDecision(); renderEnvelope(); renderSailPlan(); renderReefControls();
    el("storeVer").textContent = state.detail.code + " · 数据版本 v" + d.version;
  }).catch(function (e) { toast(e.message, true); });
}

function statusBanner(dec) {
  var cls, title;
  if (dec.status === "safe") { cls = "safe"; title = "✓ 安全：当前档位满足全部约束"; }
  else if (dec.status === "reef_required") { cls = "reef"; title = "⚠ 必须缩帆：存在满足约束的最小方案"; }
  else { cls = "bad"; title = "✕ 无解：即使全部收至最深档仍不安全"; }
  var maxCur = dec.current.maxSafeBeaufort;
  var maxSol = dec.solution ? dec.solution.maxSafeBeaufort : null;
  return '<div class="banner ' + cls + '"><h2>' + title + "</h2>" +
    "<div>当前档位最大安全风级：<b>" + (maxCur === null ? "无（任何风级都不安全）" : maxCur + " 级") + "</b>" +
    (dec.solution ? "　|　建议方案最大安全风级：<b>" + maxSol + " 级</b>" : "") + "</div></div>";
}

function renderDecision() {
  var dec = state.decision, rig = state.detail;
  var ev = dec.current.evaluation;
  var rows = function (e) {
    return "<table><tr><th>指标</th><th>数值</th></tr>" +
      "<tr><td style='text-align:left'>风压（含阵风 ×" + e.wind.gust + "）</td><td>" + fmt(e.wind.pressure, 1) + " Pa</td></tr>" +
      "<tr><td style='text-align:left'>横向受风面积</td><td>" + fmt(e.forceCenter.areaProjected, 2) + " m²</td></tr>" +
      "<tr><td style='text-align:left'>合力中心（纵向 / 高度）</td><td>" + fmt(e.forceCenter.x) + " / " + fmt(e.forceCenter.z) + " m</td></tr>" +
      "<tr><td style='text-align:left'>风压力矩（正浮）</td><td>" + fmt(e.moment.windHeel, 0) + " N·m</td></tr>" +
      "<tr><td style='text-align:left'>平衡（危险）倾角</td><td>" + (e.heel.equilibrium === null ? "≥ " + e.heel.danger + "°" : fmt(e.heel.equilibrium, 1) + "°") + " / 危险 " + e.heel.danger + "°</td></tr>" +
      "<tr><td style='text-align:left'>危险角复原裕度 / 安全系数</td><td>" + fmt(e.moment.marginAtDanger, 2) + " / " + rig.limits.safetyFactor + "</td></tr>" +
      "<tr><td style='text-align:left'>纵向平衡</td><td>" + (e.longitudinal.within ? "在 [" + e.longitudinal.min + ", " + e.longitudinal.max + "] 内" : "超出 [" + e.longitudinal.min + ", " + e.longitudinal.max + "]") + "</td></tr></table>";
  };
  var solHtml = "";
  if (dec.solution) {
    var lv = Object.keys(dec.solution.levels).map(function (id) {
      var s = rig.sails.find(function (x) { return x.id === id; });
      return (s ? s.name : id) + " " + (state.detail.currentLevels[id] || 0) + "→" + dec.solution.levels[id] + " 档";
    }).join("、");
    solHtml = "<h3>最小缩帆方案</h3><div>" + esc(lv) + '（共 ' + dec.solution.increments + ' 个档距，保留 ' + Math.round(dec.solution.keptAreaFraction * 100) + '% 帆面积）</div>';
  }
  el("decisionPanel").innerHTML =
    statusBanner(dec) +
    '<div class="grid2"><div><h3>原因</h3><div>' + esc(dec.reason) + '</div>' +
    '<h3>下一步</h3><div>' + esc(dec.nextStep) + '</div>' + solHtml + '</div>' +
    "<div><h3>当前档位物理核算</h3>" + rows(ev) + "</div></div>";
  el("applyFirst").disabled = !dec.solution || dec.status !== "reef_required";
}

function renderReefControls() {
  if (!state.detail) return;
  var rig = state.detail, dec = state.decision;
  var html = '<div class="meta">数据版本 v' + rig.version + '；当前档位：' + Object.keys(rig.currentLevels).map(function (k) {
    var s = rig.sails.find(function (x) { return x.id === k; });
    return (s ? s.name : k) + " " + rig.currentLevels[k] + " 档";
  }).join("、") + "</div>";
  rig.sails.forEach(function (s) {
    var cur = rig.currentLevels[s.id] || 0;
    var maxLvl = s.reefs.length - 1;
    var target = dec && dec.solution ? dec.solution.levels[s.id] : null;
    html += '<div class="sailrow"><div><b>' + esc(s.name) + '</b> <span class="meta">' + esc(s.id) + " · " + s.area + ' m² · 形心 x=' + s.centroid.x + " z=" + s.centroid.z +
      (target !== null && target !== cur ? '　<b style="color:#b5781a">建议→ ' + target + " 档</b>" : "") + '</span></div>' +
      '<button class="lvlbtn secondary" data-op="out" data-sail="' + esc(s.id) + '"' + (cur <= 0 ? " disabled" : "") + ">放</button>" +
      '<span class="lvl">' + cur + " / " + maxLvl + " 档</span>" +
      '<button class="lvlbtn" data-op="in" data-sail="' + esc(s.id) + '"' + (cur >= maxLvl ? " disabled" : "") + ">收</button></div>";
  });
  el("reefControls").innerHTML = html;
  Array.prototype.forEach.call(document.querySelectorAll(".lvlbtn"), function (btn) {
    btn.onclick = function () {
      var id = btn.getAttribute("data-sail");
      var cur = rig.currentLevels[id] || 0;
      var to = cur + (btn.getAttribute("data-op") === "in" ? 1 : -1);
      postMoves([{ sailId: id, toLevel: to }]);
    };
  });
}

function postMoves(moves) {
  var rig = state.detail;
  api("/api/rigs/" + encodeURIComponent(rig.code) + "/reef", {
    method: "POST",
    body: JSON.stringify({ moves: moves, expectedVersion: rig.version, beaufort: state.wind.beaufort, direction: state.wind.direction })
  }).then(function (d) {
    state.detail = d.rig; state.decision = d.decision;
    renderDecision(); renderEnvelope(); renderSailPlan(); renderReefControls();
    el("storeVer").textContent = d.rig.code + " · 数据版本 v" + d.rig.version;
    return loadRigs(d.rig.code);
  }).catch(function (e) {
    if (e.status === 409) {
      showConflict(e.data);
    } else if (e.status === 422) {
      toast((e.data.details || []).map(function (x) { return x.message; }).join("；") || e.message, true);
    } else { toast(e.message, true); }
  });
}

function showConflict(data) {
  var box = el("conflictBox");
  box.style.display = "block";
  box.innerHTML = "<b>版本冲突：</b>" + esc((data.message || ("当前服务端版本 v" + data.currentVersion)).replace(/^版本冲突[:：]\s*/, "")) + '。<button class="secondary" style="margin-left:10px" id="conflictReload">拉取最新版本</button>';
  el("conflictReload").onclick = function () { selectRig(state.detail.code); };
}
function hideConflict() { el("conflictBox").style.display = "none"; }

el("applyFirst").onclick = function () {
  var dec = state.decision;
  if (!dec || !dec.solution) return;
  var moves = dec.solution.firstMoves.map(function (m) { return { sailId: m.sailId, toLevel: m.to }; });
  postMoves(moves);
};

// ---- 帆面中心侧视图 ----
function renderSailPlan() {
  if (!state.detail) return;
  var rig = state.detail, dec = state.decision;
  var W = 560, H = 360, pad = 46;
  var xs = rig.sails.map(function (s) { return s.centroid.x; });
  var zs = rig.sails.map(function (s) { return s.centroid.z; });
  var xMin = Math.min.apply(null, xs.concat(rig.limits.xRange)) - 6;
  var xMax = Math.max.apply(null, xs.concat(rig.limits.xRange)) + 6;
  var zMax = Math.max.apply(null, zs) + 5;
  function X(x) { return pad + (x - xMin) / (xMax - xMin) * (W - 2 * pad); }
  function Z(z) { return H - pad - z / zMax * (H - 2 * pad); }
  var svg = '<svg viewBox="0 0 ' + W + " " + H + '" role="img">';
  // 网格
  for (var gz = 0; gz <= zMax; gz += 4) {
    svg += '<line x1="' + pad + '" y1="' + Z(gz) + '" x2="' + (W - pad) + '" y2="' + Z(gz) + '" stroke="#e7ece4"/>';
    svg += '<text x="6" y="' + (Z(gz) + 4) + '" font-size="10" fill="#6a7266">' + gz + "m</text>";
  }
  for (var gx = Math.ceil(xMin / 4) * 4; gx <= xMax; gx += 4) {
    svg += '<line x1="' + X(gx) + '" y1="' + pad + '" x2="' + X(gx) + '" y2="' + (H - pad) + '" stroke="#e7ece4"/>';
    svg += '<text x="' + (X(gx) - 8) + '" y="' + (H - pad + 16) + '" font-size="10" fill="#6a7266">x=' + gx + "</text>";
  }
  // 水线与船体
  svg += '<line x1="' + pad + '" y1="' + Z(0) + '" x2="' + (W - pad) + '" y2="' + Z(0) + '" stroke="#3a6e9e" stroke-width="2"/>';
  svg += '<polygon points="' + X(xMin + 2) + "," + Z(0) + " " + X(xMax - 2) + "," + Z(0) + " " + X(xMax - 6) + "," + Z(-3.4) + " " + X(xMin + 6) + "," + Z(-3.4) + '" fill="#c9b78a" opacity="0.55"/>';
  // 纵向平衡范围
  svg += '<rect x="' + X(rig.limits.xRange[0]) + '" y="' + pad + '" width="' + (X(rig.limits.xRange[1]) - X(rig.limits.xRange[0])) + '" height="' + (H - 2 * pad) + '" fill="#3f7d4a" opacity="0.07"/>';
  // 帆面（矩形面积∝帆面积，居中于形心；深色=当前，浅色=满帆轮廓）
  var maxArea = Math.max.apply(null, rig.sails.map(function (s) { return s.area; }));
  var states = dec ? dec.current.evaluation.sailStates : rig.sails.map(function (s) { return { sailId: s.id, name: s.name, area: s.area, centroid: s.centroid, level: 0, areaFactor: 1 }; });
  states.forEach(function (st) {
    var s = rig.sails.find(function (x) { return x.id === st.sailId; });
    var w = 26 + (s.area / maxArea) * 46;
    var hFull = 40 + (s.area / maxArea) * 110;
    var hNow = hFull * st.areaFactor;
    var cx = X(st.centroid.x), cz = Z(st.centroid.z);
    svg += '<rect x="' + (cx - w / 2) + '" y="' + (cz - hFull / 2) + '" width="' + w + '" height="' + hFull + '" fill="none" stroke="#9aa597" stroke-dasharray="4 3"/>';
    var color = st.level === 0 ? "#8a6a3a" : "#b5781a";
    svg += '<rect x="' + (cx - w / 2) + '" y="' + (cz - hNow / 2) + '" width="' + w + '" height="' + hNow + '" fill="' + color + '" opacity="0.55" stroke="#6b4f22"/>';
    svg += '<rect x="' + (cx - 2.5) + '" y="' + (cz - 2.5) + '" width="5" height="5" fill="#222"/>';
    svg += '<text x="' + (cx - w / 2) + '" y="' + (cz - hFull / 2 - 5) + '" font-size="11" fill="#1f241d">' + esc(st.name) + "(" + st.level + "档)</text>";
  });
  // 合力中心：当前 ×，建议 +
  if (dec) {
    var ce = dec.current.evaluation.forceCenter;
    svg += ceMarker(X(ce.x), Z(ce.z), "#a8362f", "×", "当前合力中心");
    if (dec.solution) {
      var ce2 = dec.solution.evaluation.forceCenter;
      svg += ceMarker(X(ce2.x), Z(ce2.z), "#2f5d8a", "+", "建议合力中心");
    }
  }
  svg += "</svg>";
  el("sailPlan").innerHTML = svg;
}
function ceMarker(x, y, color, sym, label) {
  return '<text x="' + (x + 6) + '" y="' + (y - 6) + '" font-size="15" font-weight="700" fill="' + color + '">' + sym + " " + label + "</text>" +
    '<circle cx="' + x + '" cy="' + y + '" r="4" fill="' + color + '"/>';
}

// ---- 安全包络 ----
function renderEnvelope() {
  if (!state.decision) return;
  var rig = state.detail, dec = state.decision;
  var pts = dec.current.envelope;
  var W = 560, H = 300, pad = 46;
  var danger = rig.limits.dangerHeel;
  function Xb(b) { return pad + b / 12 * (W - 2 * pad); }
  function Yh(h) { return H - pad - Math.min(h, danger + 8) / (danger + 10) * (H - 2 * pad); }
  var svg = '<svg viewBox="0 0 ' + W + " " + H + '">';
  // 安全区底纹
  svg += '<rect x="' + pad + '" y="' + Yh(danger) + '" width="' + (W - 2 * pad) + '" height="' + (H - pad - Yh(danger)) + '" fill="#3f7d4a" opacity="0.08"/>';
  // 危险角线
  svg += '<line x1="' + pad + '" y1="' + Yh(danger) + '" x2="' + (W - pad) + '" y2="' + Yh(danger) + '" stroke="#a8362f" stroke-dasharray="6 4"/>';
  svg += '<text x="' + (W - pad - 150) + '" y="' + (Yh(danger) - 5) + '" font-size="11" fill="#a8362f">危险倾角 ' + danger + "°</text>";
  // 坐标轴
  svg += '<line x1="' + pad + '" y1="' + pad + '" x2="' + pad + '" y2="' + (H - pad) + '" stroke="#444"/>';
  svg += '<line x1="' + pad + '" y1="' + (H - pad) + '" x2="' + (W - pad) + '" y2="' + (H - pad) + '" stroke="#444"/>';
  for (var b = 0; b <= 12; b += 2) svg += '<text x="' + (Xb(b) - 6) + '" y="' + (H - pad + 16) + '" font-size="10" fill="#6a7266">' + b + "</text>";
  svg += '<text x="' + (W / 2 - 40) + '" y="' + (H - 6) + '" font-size="11" fill="#444">蒲福风级</text>';
  // 平衡倾角折线（无解点按危险角处理）
  var path = "";
  pts.forEach(function (pt) {
    var h = pt.heel === null ? danger : pt.heel;
    path += (path ? " L" : "M") + Xb(pt.beaufort) + " " + Yh(h);
  });
  svg += '<path d="' + path + '" fill="none" stroke="#2f5d8a" stroke-width="2"/>';
  pts.forEach(function (pt) {
    var h = pt.heel === null ? danger : pt.heel;
    var cur = pt.beaufort === state.wind.beaufort;
    svg += '<circle cx="' + Xb(pt.beaufort) + '" cy="' + Yh(h) + '" r="' + (cur ? 6 : 4) + '" fill="' + (pt.safe ? "#3f7d4a" : "#a8362f") + '" stroke="' + (cur ? "#000" : "#fff") + '"/>';
  });
  var msb = dec.current.maxSafeBeaufort;
  if (msb !== null && msb >= 0) {
    svg += '<text x="' + Xb(msb) + '" y="' + (pad + 12) + '" font-size="11" fill="#3f7d4a">最大安全 ' + msb + " 级</text>";
  } else {
    svg += '<text x="' + (pad + 6) + '" y="' + (pad + 12) + '" font-size="11" fill="#a8362f">当前档位无安全风级</text>';
  }
  svg += "</svg>";
  el("envelope").innerHTML = svg;
}

// ---- 登记提交 ----
el("regSubmit").onclick = function () { submitRig(false); };
el("regUpdate").onclick = function () { submitRig(true); };
function submitRig(isUpdate) {
  var data;
  try { data = JSON.parse(el("regJson").value); }
  catch (e) { el("regErr").textContent = "JSON 解析失败：" + e.message; return; }
  var target = el("regTarget").value;
  var url = isUpdate ? "/api/rigs/" + encodeURIComponent(target || data.code) : "/api/rigs";
  if (isUpdate) {
    data.expectedVersion = rigVersion(target);
    data.levelPolicy = el("levelPolicy").value;
  }
  api(url, { method: isUpdate ? "PUT" : "POST", body: JSON.stringify(data) })
    .then(function (d) {
      el("regErr").textContent = "";
      var msg = isUpdate ? "已更新至 v" + d.rig.version : "已登记 " + d.rig.code + " v" + d.rig.version;
      if (isUpdate && d.migrations && d.migrations.length) {
        msg += "；档位迁移：" + d.migrations.map(function (m) {
          return m.sailId + " " + (m.from === null ? "∅" : m.from) + "→" + (m.to === null ? "删除" : m.to);
        }).join("、");
      }
      toast(msg);
      return loadRigs(d.rig.code).then(function () { return selectRig(d.rig.code); });
    })
    .catch(function (e) {
      if (e.status === 422) el("regErr").textContent = (e.data.details || []).map(function (x) { return "• [" + x.code + "] " + x.message; }).join("\\n");
      else if (e.status === 409) el("regErr").textContent = "版本冲突：" + (e.data.message || "") + "（服务端 v" + e.data.currentVersion + "）";
      else el("regErr").textContent = e.message;
    });
}
function rigVersion(code) {
  var r = state.rigs.find(function (x) { return x.code === code; });
  return r ? r.version : null;
}

// ---- 旧版台账 ----
function loadItems() {
  api("/api/items").then(function (items) {
    el("mList").innerHTML = items.map(function (it) {
      var ident = it.id || it.code;
      var tasks = (it.tasks || []).map(function (t) {
        var logs = (t.logs || []).map(function (l) {
          return '<div class="meta">· ' + esc(l.at) + " " + esc(l.note) + "</div>";
        }).join("");
        return '<div style="border:1px solid #dfe6db;border-radius:6px;padding:7px 9px;margin:6px 0">' +
          '<b>' + esc(t.id) + "</b> " + esc(t.position) + ' <span class="pill">' + esc(t.tension || "") + "</span> " +
          '<span class="pill">' + esc(t.status || "") + "</span>" + logs + "</div>";
      }).join("");
      var modelLogs = (it.logs || []).map(function (l) {
        return '<div class="meta">· ' + esc(l.at) + " [" + esc(l.step || "记录") + "] " + esc(l.note) + "</div>";
      }).join("");
      return '<div style="border:1px solid #cfd8ca;border-radius:8px;padding:10px;margin:10px 0">' +
        '<div><b>' + esc(it.code) + "</b> " + esc(it.shipType || "") + ' <span class="pill">' + esc(it.status || "") +
        '</span> <span class="meta">' + esc(it.owner || "") + " · " + esc(it.scale || "") + "</span></div>" +
        '<div class="meta" style="margin:5px 0">帆索任务（' + (it.tasks || []).length + " 条）</div>" + (tasks || '<div class="meta">无</div>') +
        '<div class="meta" style="margin:7px 0 2px">模型日志（' + (it.logs || []).length + " 条）</div>" + (modelLogs || '<div class="meta">无</div>') +
        '<div style="display:flex;gap:6px;margin-top:8px">' +
        '<input class="m-log-note" data-id="' + esc(ident) + '" placeholder="追加模型日志…" style="flex:1">' +
        '<button class="blue m-log-btn" data-id="' + esc(ident) + '">追加</button></div></div>';
    }).join("") || '<div class="meta">暂无</div>';
    Array.prototype.forEach.call(document.querySelectorAll(".m-log-btn"), function (btn) {
      btn.onclick = function () {
        var id = btn.getAttribute("data-id");
        var inp = document.querySelector('.m-log-note[data-id="' + id + '"]');
        var note = inp.value.trim();
        if (!note) return;
        api("/api/items/" + encodeURIComponent(id) + "/logs", {
          method: "POST", body: JSON.stringify({ step: "页面记录", note: note }),
        }).then(function () { toast("已追加日志"); loadItems(); })
          .catch(function (e) { toast(e.message, true); });
      };
    });
  }).catch(function () {});
}
el("mAdd").onclick = function () {
  api("/api/items", { method: "POST", body: JSON.stringify({ code: el("mCode").value, shipType: el("mType").value, owner: el("mOwner").value, status: "待检查" }) })
    .then(function () { el("mCode").value = ""; el("mType").value = ""; el("mOwner").value = ""; toast("已新增模型"); loadItems(); })
    .catch(function (e) { toast(e.message, true); });
};

el("reload").onclick = function () { loadRigs(state.rig && state.rig.code).then(function () { if (state.rig) return selectRig(state.rig.code); }).then(loadItems); };

initWind();
loadRigs().then(function () {
  if (state.rigs.length) return selectRig(state.rigs[0].code);
}).then(loadItems);
</script>
</body>
</html>`;
}
