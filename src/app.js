// HTTP 应用：帆装配平登记 + 分级缩帆决策，保留旧版帆索校准接口。
import {
  ConflictError, NotFoundError, ValidationError,
  validateMoves, validateRig, validateWind,
} from "./domain.js";
import { decide } from "./reef.js";
import { renderPage } from "./page.js";

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new ValidationError([{ code: "JSON_INVALID", path: "", message: `请求体不是合法 JSON: ${e.message}` }]);
  }
}

export function createApp(store) {
  const rigSummary = (r) => ({
    code: r.code, name: r.name, displacement: r.displacement,
    sailCount: r.sails.length, version: r.version, currentLevels: r.currentLevels,
    limits: r.limits, updatedAt: r.updatedAt,
  });

  async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const q = url.searchParams;

    try {
      if (req.method === "GET" && p === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(renderPage());
      }

      if (req.method === "GET" && p === "/health") return send(res, 200, { ok: true });

      // ---- 帆装配平 -------------------------------------------------------
      if (req.method === "GET" && p === "/api/rigs") {
        const rigs = await store.listRigs();
        return send(res, 200, { rigs: rigs.map(rigSummary) });
      }
      if (req.method === "POST" && p === "/api/rigs") {
        const input = await readJson(req);
        const rig = validateRig(input);
        const { rig: saved } = await store.createRig(rig, { by: input.by });
        return send(res, 201, { rig: saved });
      }

      const rigPath = p.match(/^\/api\/rigs\/([^/]+)$/);
      if (rigPath && req.method === "GET") {
        const rig = await store.getRig(decodeURIComponent(rigPath[1]));
        return send(res, 200, { rig });
      }
      if (rigPath && req.method === "PUT") {
        const code = decodeURIComponent(rigPath[1]);
        const input = await readJson(req);
        const expectedVersion = input.expectedVersion ?? req.headers["if-match"];
        const rig = validateRig({ ...input, code: input.code || code });
        if (rig.code !== code) {
          throw new ValidationError([{ code: "RIG_CODE_MISMATCH", path: "code", message: "路径编号与请求体编号不一致" }]);
        }
        const { rig: saved } = await store.replaceRig(code, rig, expectedVersion, { by: input.by });
        return send(res, 200, { rig: saved });
      }

      // 缩帆决策（只读）：?beaufort=6&direction=90
      const decidePath = p.match(/^\/api\/rigs\/([^/]+)\/decision$/);
      if (decidePath && req.method === "GET") {
        const rec = await store.getRig(decodeURIComponent(decidePath[1]));
        const wind = validateWind({ beaufort: q.get("beaufort"), windDirection: q.get("direction") });
        const result = decide(rec, wind, rec.currentLevels);
        return send(res, 200, { version: rec.version, decision: result });
      }

      // 包络（只读，按当前档位）
      const envPath = p.match(/^\/api\/rigs\/([^/]+)\/envelope$/);
      if (envPath && req.method === "GET") {
        const rec = await store.getRig(decodeURIComponent(envPath[1]));
        const direction = Number(q.get("direction") ?? 90);
        const result = decide(rec, { beaufort: 0, direction }, rec.currentLevels);
        return send(res, 200, {
          version: rec.version,
          direction,
          envelope: result.current.envelope,
          maxSafeBeaufort: result.current.maxSafeBeaufort,
        });
      }

      // 逐级缩帆作业（唯一能改档位的入口；CAS + 逐级校验）
      const movesPath = p.match(/^\/api\/rigs\/([^/]+)\/reef$/);
      if (movesPath && req.method === "POST") {
        const code = decodeURIComponent(movesPath[1]);
        const rec0 = await store.getRig(code);
        const input = await readJson(req);
        const expectedVersion = input.expectedVersion ?? req.headers["if-match"];
        const moves = validateMoves(rec0, rec0.currentLevels, input.moves);
        const { rig } = await store.applyMoves(code, moves, expectedVersion, { by: input.by });
        const wind = validateWind({
          beaufort: input.beaufort ?? 6,
          windDirection: input.direction ?? 90,
        });
        const decision = decide(rig, wind, rig.currentLevels);
        return send(res, 200, { rig, decision });
      }

      // ---- 旧版帆索校准（保留） -------------------------------------------
      if (req.method === "GET" && p === "/api/items") {
        const items = await store.listItems();
        return send(res, 200, items);
      }
      if (req.method === "POST" && p === "/api/items") {
        const input = await readJson(req);
        const item = {
          id: "MR-" + Date.now(),
          ...input,
          logs: [{ at: new Date().toISOString(), step: "建档", note: "创建模型" }],
          tasks: [],
        };
        const saved = await store.addItem(item);
        return send(res, 201, saved);
      }
      const itemPatch = p.match(/^\/api\/items\/([^/]+)$/);
      if (itemPatch && req.method === "PATCH") {
        const input = await readJson(req);
        const item = await store.mutateItem(decodeURIComponent(itemPatch[1]), (it) => {
          Object.assign(it, input);
          it.logs ||= [];
          it.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + it.status });
        });
        return send(res, 200, item);
      }
      const itemLog = p.match(/^\/api\/items\/([^/]+)\/logs$/);
      if (itemLog && req.method === "POST") {
        const input = await readJson(req);
        const item = await store.mutateItem(decodeURIComponent(itemLog[1]), (it) => {
          it.logs ||= [];
          it.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
        });
        return send(res, 201, item);
      }
      const itemAction = p.match(/^\/api\/items\/([^/]+)\/action$/);
      if (itemAction && req.method === "POST") {
        const input = await readJson(req);
        const item = await store.mutateItem(decodeURIComponent(itemAction[1]), (it) => {
          it.logs ||= [];
          it.tasks ||= [];
          it.tasks.push({
            id: "T-" + Date.now(), position: input.position, tension: input.tension,
            status: "待检查", logs: [{ at: new Date().toISOString(), note: input.note || "新增帆索任务" }],
          });
          it.status = "校准中";
          it.logs.push({ at: new Date().toISOString(), step: "帆索", note: input.position + " · " + input.tension });
        });
        return send(res, 201, item);
      }
      if (req.method === "GET" && p === "/api/stats") {
        const items = await store.listItems();
        const labels = ["待检查", "校准中", "待复核", "已交付"];
        const stats = Object.fromEntries(labels.map((l) => [l, 0]));
        for (const it of items) if (stats[it.status] !== undefined) stats[it.status] += 1;
        return send(res, 200, stats);
      }

      return send(res, 404, { error: "not_found", path: p });
    } catch (error) {
      if (error instanceof ValidationError) {
        return send(res, 422, { error: "validation_failed", details: error.errors });
      }
      if (error instanceof ConflictError) {
        return send(res, 409, { error: error.code, message: error.message, currentVersion: error.currentVersion });
      }
      if (error instanceof NotFoundError) {
        return send(res, 404, { error: error.code, message: error.message });
      }
      return send(res, 500, { error: "internal_error", message: error.message });
    }
  }

  return handler;
}
