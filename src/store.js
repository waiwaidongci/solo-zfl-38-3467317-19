// JSON 文件持久化存储。
//
// 并发与一致性保证：
//  1) 单写者队列：所有变更串行化，读快照也在同一队列内，避免读到半截状态；
//  2) 乐观版本号（CAS）：每次变更必须携带 expectedVersion，版本不符抛 ConflictError，
//     「并发只生成一个不可覆盖版本」——后到的写被拒绝，而不是覆盖先到的版本；
//  3) 原子落盘：写 *.tmp + fsync + rename，进程崩溃不会出现半截 JSON；
//  4) 整体回滚：变更回调中抛错（含磁盘写失败）时，内存状态不替换、文件不动；
//  5) 重启恢复：下次启动从同一文件读出，版本号继续递增。

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import * as fssync from "node:fs";
import { dirname, join } from "node:path";

import { ConflictError, NotFoundError } from "./domain.js";

const FILE_VERSION = 2;

function bump(version) {
  // 单调递增版本号；同毫秒内多次写入也不会重复
  return version + 1;
}

const fsync = (fd) => new Promise((resolve, reject) => {
  fssync.fsync(fd, (err) => (err ? reject(err) : resolve()));
});

export class JsonStore {
  constructor(filePath, seedFactory) {
    this.filePath = filePath;
    this.seedFactory = seedFactory; // () => ({ rigs, items })
    this.chain = Promise.resolve();
    this.state = null; // { fileVersion, rigs, items, version, updatedAt }
  }

  async _atomicWrite(state) {
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    const fh = await fs.open(tmp, "w");
    try {
      await fh.writeFile(JSON.stringify(state, null, 2), "utf8");
      await fsync(fh.fd);
    } finally {
      await fh.close().catch(() => {});
    }
    await fs.rename(tmp, this.filePath);
    // fsync 目录，保证 rename 落盘（重启/掉电安全）；个别文件系统不支持则忽略
    const dir = await fs.open(dirname(this.filePath));
    try { await fsync(dir.fd); } catch { /* 目录 fsync 不被支持时可忽略 */ } finally { await dir.close(); }
  }

  async _ensureLoaded() {
    if (this.state) return;
    if (!existsSync(this.filePath)) {
      await fs.mkdir(dirname(this.filePath), { recursive: true });
      this.state = {
        fileVersion: FILE_VERSION,
        version: 1,
        updatedAt: new Date().toISOString(),
        ...this.seedFactory(),
      };
      await this._atomicWrite(this.state);
      return;
    }
    const raw = await fs.readFile(this.filePath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`持久化文件损坏，拒绝启动: ${e.message}`);
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("持久化文件不是有效对象，拒绝启动");
    }
    // v1（帆索校准）-> v2（增加帆装配平）：保留既有 items，补 rigs 并落盘一次
    let migrated = false;
    if (!Array.isArray(parsed.rigs)) {
      parsed.rigs = this.seedFactory().rigs;
      parsed.fileVersion = FILE_VERSION;
      migrated = true;
    }
    if (!Array.isArray(parsed.items)) parsed.items = [];
    if (typeof parsed.version !== "number") { parsed.version = 1; migrated = true; }
    this.state = parsed;
    if (migrated) await this._atomicWrite(this.state);
  }

  // 把一个变更排入单写者队列。mutator 在可变草稿上操作，返回结果；
  // 抛错则草稿丢弃（回滚），成功才原子落盘并替换快照。
  _enqueue(mutator) {
    const run = this.chain.then(async () => {
      await this._ensureLoaded();
      const draft = structuredClone(this.state);
      const result = await mutator(draft);
      draft.version = bump(draft.version);
      draft.updatedAt = new Date().toISOString();
      try {
        await this._atomicWrite(draft);
      } catch (e) {
        // 写入失败：保留旧快照，整体回滚
        throw new Error(`持久化写入失败，已回滚: ${e.message}`);
      }
      this.state = draft;
      return result;
    });
    // 不让队列因一次失败而永久 reject
    this.chain = run.then(() => {}, () => {});
    return run;
  }

  // 只读快照（排队执行以与写入互斥）
  async read() {
    const run = this.chain.then(async () => {
      await this._ensureLoaded();
      return structuredClone(this.state);
    });
    this.chain = run.then(() => {}, () => {});
    return run;
  }

  // ---- 帆装配平 -----------------------------------------------------------

  async listRigs() {
    const s = await this.read();
    return s.rigs.map((r) => ({ ...r }));
  }

  async getRig(code) {
    const s = await this.read();
    const rig = s.rigs.find((r) => r.code === code);
    if (!rig) throw new NotFoundError("rig_not_found", `船只 ${code} 未登记`);
    return structuredClone(rig);
  }

  // 新建帆装（code 不允许覆盖已有船只）
  async createRig(rig, meta = {}) {
    return this._enqueue((draft) => {
      if (draft.rigs.some((r) => r.code === rig.code)) {
        throw new ConflictError("RIG_EXISTS", `船只 ${rig.code} 已存在，登记接口不允许覆盖`, draft.version);
      }
      const rec = {
        ...rig,
        version: 1,
        currentLevels: Object.fromEntries(rig.sails.map((s) => [s.id, 0])),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        createdBy: meta.by || "anonymous",
      };
      draft.rigs.push(rec);
      return { rig: structuredClone(rec), version: 1 };
    });
  }

  // 替换整套帆装配平。expectedVersion 必填；不符 -> ConflictError（不可覆盖）。
  async replaceRig(code, rig, expectedVersion, meta = {}) {
    return this._enqueue((draft) => {
      const idx = draft.rigs.findIndex((r) => r.code === code);
      if (idx < 0) throw new NotFoundError("rig_not_found", `船只 ${code} 未登记`);
      const existing = draft.rigs[idx];
      if (expectedVersion === undefined || expectedVersion === null) {
        throw new ConflictError("VERSION_REQUIRED", "替换帆装必须携带 expectedVersion（过期版本保护）", existing.version);
      }
      if (Number(expectedVersion) !== existing.version) {
        throw new ConflictError("VERSION_CONFLICT",
          `版本冲突：本地依据 v${expectedVersion}，当前已是 v${existing.version}，拒绝覆盖`, existing.version);
      }
      const rec = {
        ...rig,
        version: existing.version + 1,
        currentLevels: existing.currentLevels,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
        createdBy: existing.createdBy,
        updatedBy: meta.by || "anonymous",
      };
      draft.rigs[idx] = rec;
      return { rig: structuredClone(rec), version: rec.version };
    });
  }

  // 逐级缩帆作业。moves 已由领域层校验；同样做 CAS。
  async applyMoves(code, moves, expectedVersion, meta = {}) {
    return this._enqueue((draft) => {
      const rig = draft.rigs.find((r) => r.code === code);
      if (!rig) throw new NotFoundError("rig_not_found", `船只 ${code} 未登记`);
      if (expectedVersion === undefined || expectedVersion === null) {
        throw new ConflictError("VERSION_REQUIRED", "缩帆作业必须携带 expectedVersion（过期版本保护）", rig.version);
      }
      if (Number(expectedVersion) !== rig.version) {
        throw new ConflictError("VERSION_CONFLICT",
          `版本冲突：本地依据 v${expectedVersion}，当前已是 v${rig.version}，拒绝覆盖`, rig.version);
      }
      rig.currentLevels ||= {};
      for (const m of moves) {
        rig.currentLevels[m.sailId] = m.toLevel;
      }
      rig.version += 1;
      rig.updatedAt = new Date().toISOString();
      rig.updatedBy = meta.by || "anonymous";
      rig.logs ||= [];
      rig.logs.push({
        at: rig.updatedAt,
        step: "缩帆作业",
        note: moves.map((m) => `${m.sailId}→${m.toLevel}档`).join("、"),
        by: meta.by || "anonymous",
      });
      return { rig: structuredClone(rig), version: rig.version };
    });
  }

  // ---- 旧版帆索校准模型（保留原型功能） -----------------------------------

  async listItems() {
    const s = await this.read();
    return structuredClone(s.items);
  }

  async mutateItem(codeOrId, fn) {
    return this._enqueue((draft) => {
      const item = draft.items.find((x) => x.id === codeOrId || x.code === codeOrId);
      if (!item) throw new NotFoundError("item_not_found", "模型不存在");
      const out = fn(item, draft);
      return structuredClone(out || item);
    });
  }

  async addItem(item) {
    return this._enqueue((draft) => {
      draft.items.unshift(item);
      return structuredClone(item);
    });
  }
}

export { FILE_VERSION };
