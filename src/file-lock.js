// 跨实例文件互斥锁：同一路径的运行时库在多个进程间共享时，
// 迁移（首次播种/导入）与提交写入都必须先拿到这把锁。
//
// 实现：O_CREAT|O_EXCL 原子创建 lock 文件；锁内含 token/pid/hostname/时间。
// 竞争者轮询等待；持锁进程已死且锁陈旧（或锁内容损坏）时可安全接管（恢复）。
// 释放只按 token 删除自己的锁，绝不误删后来者的锁。

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export class LockTimeoutError extends Error {
  constructor(path, waitedMs) {
    super(`获取数据锁超时（${waitedMs}ms）：${path} 正被另一实例占用`);
    this.name = "LockTimeoutError";
    this.code = "LOCK_TIMEOUT";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

export class FileLock {
  constructor(filePath, { waitMs = 5000, staleMs = 15000, pollMs = 40 } = {}) {
    this.lockPath = filePath + ".lock";
    this.waitMs = waitMs;
    this.staleMs = staleMs;
    this.pollMs = pollMs;
    this.hostname = os.hostname();
  }

  async _readMeta() {
    try {
      const raw = await fs.readFile(this.lockPath, "utf8");
      return JSON.parse(raw);
    } catch {
      return null; // 读不到/损坏：调用方据此判断陈旧
    }
  }

  // 锁陈旧：内容损坏，或（同机）持锁进程已死且超过陈旧时限，
  // 或时间戳缺失/异常且超过陈旧时限。
  async _isStale() {
    if (!existsSync(this.lockPath)) return true;
    let stat;
    try { stat = await fs.stat(this.lockPath); } catch { return true; }
    const meta = await this._readMeta();
    const age = Date.now() - stat.mtimeMs;
    if (!meta || typeof meta !== "object" || !meta.token) return age > 250;
    if (meta.hostname && meta.hostname !== this.hostname) {
      // 跨主机无法探活：只在明显超龄时接管
      return age > Math.max(this.staleMs * 4, 60_000);
    }
    const alive = Number.isInteger(meta.pid) && pidAlive(meta.pid);
    return !alive && age > 250;
  }

  async acquire(waitMs = this.waitMs) {
    const started = Date.now();
    const token = randomUUID();
    await fs.mkdir(dirname(this.lockPath), { recursive: true });
    for (;;) {
      let created = false;
      let fh = null;
      try {
        fh = await fs.open(this.lockPath, "wx"); // O_CREAT|O_EXCL
        const payload = {
          token, pid: process.pid, hostname: this.hostname,
          startedAt: new Date().toISOString(),
        };
        await fh.writeFile(JSON.stringify(payload), "utf8");
        try { await fh.sync(); } catch { /* 某些文件系统不支持 */ }
        created = true;
        return {
          token,
          release: async () => this.release(token),
        };
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        if (await this._isStale()) {
          await fs.unlink(this.lockPath).catch(() => {});
          continue; // 接管后立即重试 O_EXCL（多个接管者仍只有一个成功）
        }
        if (Date.now() - started >= waitMs) throw new LockTimeoutError(this.lockPath, waitMs);
        await sleep(this.pollMs + Math.floor(Math.random() * this.pollMs));
      } finally {
        if (fh) await fh.close().catch(() => {});
        if (!created) { /* 未拿到锁，循环继续 */ }
      }
    }
  }

  async release(token) {
    try {
      const meta = await this._readMeta();
      if (meta && meta.token === token) await fs.unlink(this.lockPath);
    } catch { /* 释放失败不影响结果，陈旧锁可被后续接管 */ }
  }

  async withLock(fn, waitMs) {
    const h = await this.acquire(waitMs);
    try {
      return await fn();
    } finally {
      await h.release();
    }
  }
}
