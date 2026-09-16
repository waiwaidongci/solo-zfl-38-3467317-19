// JSON 文件持久化存储。
//
// 并发与一致性保证：
//  1) 单写者队列（进程内）+ FileLock（跨实例/跨进程）：迁移与每次提交写都串行化；
//  2) 乐观版本号（CAS）：每次变更必须携带 expectedVersion，提交前在锁内读取磁盘最新版本，
//     版本不符抛 ConflictError——后到的写明确失败，绝不覆盖先到实例的结果；
//  3) 原子落盘：每实例唯一名 *.tmp + fsync + rename，进程崩溃不会出现半截 JSON；
//     锁内清理上次崩溃残留 tmp，绝不删其他实例正在写的文件；
//  4) 整体回滚：变更回调中抛错（含磁盘写失败）时，内存状态不替换、文件不动；
//  5) 重启恢复：从同一文件读出，版本号继续；读时按版本号跨实例刷新缓存。

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import * as fssync from "node:fs";
import { basename, dirname, join } from "node:path";

import { ConflictError, NotFoundError, migrateLevels } from "./domain.js";
import { FileLock, LockTimeoutError } from "./file-lock.js";

export { LockTimeoutError } from "./file-lock.js";

const FILE_VERSION = 2;

function bump(version) {
  // 单调递增版本号；同毫秒内多次写入也不会重复
  return version + 1;
}

const fsync = (fd) => new Promise((resolve, reject) => {
  fssync.fsync(fd, (err) => (err ? reject(err) : resolve()));
});

export class JsonStore {
  // filePath      新运行时可写库 data/runtime.json
  // legacyPath    旧版数据文件 data/model-rigging-calibration.json（仅在运行时库缺失时迁移）
  constructor(filePath, seedFactory, { legacyPath = null, lockWaitMs = 5000, staleMs = 15000 } = {}) {
    this.filePath = filePath;
    this.legacyPath = legacyPath;
    this.seedFactory = seedFactory; // () => ({ rigs, items })
    this.chain = Promise.resolve();
    this.state = null; // { fileVersion, rigs, items, version, updatedAt }
    this.instanceId = randomUUID().slice(0, 8);
    this.lock = new FileLock(filePath, { waitMs: lockWaitMs, staleMs });
  }

  // 持锁期间清理本库崩溃残留 tmp：此刻不可能有别的实例在写本库（写必须持锁），
  // 因此匹配前缀的 tmp 必然是陈旧的。
  async _cleanStaleTmpLocked() {
    const dir = dirname(this.filePath);
    const base = basename(this.filePath);
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch { return; }
    await Promise.all(names
      .filter((n) => n.startsWith(base + ".tmp-"))
      .map((n) => fs.unlink(join(dir, n)).catch(() => {})));
  }

  async _atomicWrite(state) {
    const tmp = `${this.filePath}.tmp-${process.pid}-${this.instanceId}`;
    try {
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
    } catch (e) {
      // 任何阶段失败都清掉半套临时文件，绝不留下半截副本
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
  }

  // 从磁盘读取最新状态（必须持锁时调用）
  async _readDiskState() {
    const raw = await fs.readFile(this.filePath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`运行时数据文件损坏，拒绝写入: ${e.message}`);
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rigs)) {
      throw new Error("运行时数据文件结构非法，拒绝写入");
    }
    if (!Array.isArray(parsed.items)) parsed.items = [];
    if (typeof parsed.version !== "number") parsed.version = 1;
    return parsed;
  }

  async _ensureLoaded() {
    if (this.state) return;
    if (this._loading) return this._loading;
    this._loading = this.lock.withLock(async () => {
      if (this.state) return; // 进程内并发只做一次
      await fs.mkdir(dirname(this.filePath), { recursive: true });
      await this._cleanStaleTmpLocked();

      // 持锁后重新复查（另一实例可能刚完成迁移/播种）：
      //   1) 新运行时文件存在 -> 直接读取复用，绝不重复导入；
      //   2) 仅有旧文件       -> 安全迁移到运行时文件；
      //   3) 两处都没有       -> 从交付快照播种。
      if (existsSync(this.filePath)) {
        this.state = await this._loadRuntime();
        return;
      }
      if (this.legacyPath && existsSync(this.legacyPath)) {
        this.state = await this._migrateLegacy();
        return;
      }
      const seeded = {
        fileVersion: FILE_VERSION,
        version: 1,
        updatedAt: new Date().toISOString(),
        ...this.seedFactory(),
      };
      await this._atomicWrite(seeded);
      this.state = seeded;
    }).finally(() => { this._loading = null; });
    return this._loading;
  }

  async _loadRuntime() {
    const raw = await fs.readFile(this.filePath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`运行时数据文件损坏，拒绝启动: ${e.message}`);
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rigs)) {
      throw new Error("运行时数据文件结构非法，拒绝启动");
    }
    if (!Array.isArray(parsed.items)) parsed.items = [];
    if (typeof parsed.version !== "number") parsed.version = 1;
    return parsed;
  }

  // 读取并迁移旧版文件。旧文件只读，永不修改；结果原子写入新运行时文件。
  // 任何一步失败都抛错：此时运行时文件尚未 rename 出来，旧文件保持原样，可重试。
  async _migrateLegacy() {
    const raw = await fs.readFile(this.legacyPath, "utf8");
    let legacy;
    try {
      legacy = JSON.parse(raw);
    } catch (e) {
      throw new Error(`旧数据文件损坏，无法迁移（原文件未改动，请修复后重试）: ${e.message}`);
    }
    if (!legacy || typeof legacy !== "object") {
      throw new Error("旧数据文件不是有效对象，无法迁移（原文件未改动）");
    }
    if (legacy.items !== undefined && !Array.isArray(legacy.items)) {
      throw new Error("旧数据文件的 items 不是数组，无法迁移（原文件未改动）");
    }
    if (legacy.rigs !== undefined && !Array.isArray(legacy.rigs)) {
      throw new Error("旧数据文件的 rigs 不是数组，无法迁移（原文件未改动）");
    }

    // 保留旧台账：编号、任务、日志逐字保留；缺 id 的旧记录用 code 兜底
    const items = (legacy.items || []).map((it) => ({
      ...it,
      id: it.id || it.code,
      tasks: Array.isArray(it.tasks) ? it.tasks : [],
      logs: Array.isArray(it.logs) ? it.logs : [],
    }));

    // 若旧文件已含帆装（曾经迁移过的库），连同档位与版本一并保留；
    // 纯 v1 台账库（无 rigs）才补齐种子帆装。
    let rigs;
    if (Array.isArray(legacy.rigs)) {
      rigs = legacy.rigs;
    } else {
      rigs = this.seedFactory().rigs;
    }

    const state = {
      fileVersion: FILE_VERSION,
      version: typeof legacy.version === "number" ? legacy.version : 1,
      updatedAt: new Date().toISOString(),
      rigs,
      items,
      migration: {
        from: this.legacyPath,
        at: new Date().toISOString(),
        itemsImported: items.length,
        rigsImported: Array.isArray(legacy.rigs) ? legacy.rigs.length : 0,
      },
    };
    // 原子落盘：rename 成功才算迁移成功；失败则不留运行时文件
    await this._atomicWrite(state);
    return state;
  }

  // 把一个变更排入单写者队列。
  // mutator(base, ctx) 收到的是“磁盘最新”状态的可变草稿：进入跨实例锁后先重读，
  // 若版本已被另一实例推进，直接抛 CONCURRENT_VERSION_CONFLICT（过期写入明确失败）；
  // mutator 自身的 expectedVersion 检查、随后的原子落盘全部在锁内完成。
  // mutator 返回 { result, baseVersion }；提交版本 = baseVersion + 1。
  _enqueue(mutator) {
    const run = this.chain.then(async () => {
      await this._ensureLoaded();
      return this.lock.withLock(async () => {
        // 持锁后读最新磁盘状态（其他实例可能已提交）
        const fresh = await this._readDiskState();
        let result;
        try {
          result = await mutator(fresh);
        } catch (e) {
          // 业务/版本错误：草稿丢弃，不写盘；刷新内存缓存到最新磁盘状态
          this.state = await this._readDiskStateSafe();
          throw e;
        }
        fresh.version = bump(fresh.version);
        fresh.updatedAt = new Date().toISOString();
        try {
          await this._atomicWrite(fresh);
        } catch (e) {
          throw new Error(`持久化写入失败，已回滚: ${e.message}`);
        }
        this.state = structuredClone(fresh);
        return result;
      });
    });
    // 不让队列因一次失败而永久 reject
    this.chain = run.then(() => {}, () => {});
    return run;
  }

  async _readDiskStateSafe() {
    try { return await this._readDiskState(); } catch { return this.state; }
  }

  // 只读：优先返回跨实例最新版本（无锁，利用原子 rename 不会读到半截 JSON）；
  // 读不到时回退本实例已加载缓存。
  async read() {
    const run = this.chain.then(async () => {
      await this._ensureLoaded();
      if (existsSync(this.filePath)) {
        try {
          const disk = await this._loadRuntime();
          if (!this.state || disk.version >= this.state.version) this.state = disk;
        } catch { /* 磁盘暂时不可读时用缓存 */ }
      }
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
  // 旧 currentLevels 必须与新档位定义兼容：按 policy（clamp/reject）迁移或整体拒绝。
  async replaceRig(code, rig, expectedVersion, meta = {}) {
    const policy = meta.levelPolicy || "clamp";
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
      // 在同一事务草稿内迁移旧档位；抛 ValidationError 则草稿整体丢弃，不落盘
      const { levels, migrations } = migrateLevels(existing, rig, policy);
      const now = new Date().toISOString();
      const rec = {
        ...rig,
        version: existing.version + 1,
        currentLevels: levels,
        createdAt: existing.createdAt,
        updatedAt: now,
        createdBy: existing.createdBy,
        updatedBy: meta.by || "anonymous",
        levelMigrations: [
          ...(existing.levelMigrations || []),
          ...migrations.map((m) => ({ at: now, ...m })),
        ],
      };
      draft.rigs[idx] = rec;
      if (migrations.length) {
        rec.logs ||= [];
        rec.logs.push({
          at: now,
          step: "档位兼容迁移",
          note: migrations.map((m) => `${m.sailId}: ${m.reason}`).join("；"),
          policy,
          by: meta.by || "anonymous",
        });
      }
      return { rig: structuredClone(rec), version: rec.version, migrations };
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
