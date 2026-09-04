import crypto from 'crypto';
import { spawnSync } from 'node:child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';

const lockRecordSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  pid: z.number().int().positive(),
  hostname: z.string().min(1),
  startedAt: z.iso.datetime(),
  token: z.string().min(1),
}).strict();

type LockRecord = z.infer<typeof lockRecordSchema>;

export type LockObservation =
  | { status: 'absent' }
  | { status: 'held'; pid: number; startedAt: string }
  | { status: 'stale'; pid: number; startedAt: string }
  | { status: 'ambiguous'; reason: 'invalid' | 'foreign-host' | 'probe-failed' };

export class LockUnavailableError extends Error {
  constructor(readonly observation: LockObservation) {
    super('The lock is already held.');
    this.name = 'LockUnavailableError';
  }
}

export class AmbiguousLockError extends Error {
  constructor(readonly observation: LockObservation) {
    super('The lock owner cannot be proven dead; refusing to reclaim it.');
    this.name = 'AmbiguousLockError';
  }
}

function readLockRecord(file: string): LockRecord | null {
  try {
    return lockRecordSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

// flock locks the inherited open file description, not the short-lived helper.
// Node retains that description until release (or process death). Never unlink
// the guard: contenders must always lock the same inode, across PID namespaces.
function tryKernelLock(fd: number): boolean {
  const result = spawnSync('flock', ['--exclusive', '--nonblock', '3'], {
    stdio: ['ignore', 'ignore', 'pipe', fd],
    timeout: 5000,
  });
  if (!result.error && result.status === 0) return true;
  if (!result.error && result.status === 1) return false;
  throw new AmbiguousLockError({ status: 'ambiguous', reason: 'probe-failed' });
}

function observeKernelLock(file: string, record: LockRecord): LockObservation {
  if (process.platform !== 'linux') return { status: 'ambiguous', reason: 'probe-failed' };
  let fd: number | undefined;
  try {
    fd = fs.openSync(`${file}.guard`, 'r');
    const stale = tryKernelLock(fd);
    return { status: stale ? 'stale' : 'held', pid: record.pid, startedAt: record.startedAt };
  } catch {
    return { status: 'ambiguous', reason: 'probe-failed' };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function observeLock(file: string): LockObservation {
  if (!fs.existsSync(file)) return { status: 'absent' };
  const record = readLockRecord(file);
  if (!record) return { status: 'ambiguous', reason: 'invalid' };
  if (record.schemaVersion === 2) return observeKernelLock(file, record);
  if (record.hostname !== os.hostname()) {
    return { status: 'ambiguous', reason: 'foreign-host' };
  }
  try {
    process.kill(record.pid, 0);
    return { status: 'held', pid: record.pid, startedAt: record.startedAt };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return { status: 'stale', pid: record.pid, startedAt: record.startedAt };
    }
    if (code === 'EPERM') {
      return { status: 'held', pid: record.pid, startedAt: record.startedAt };
    }
    return { status: 'ambiguous', reason: 'probe-failed' };
  }
}

export function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(code ?? '') && process.platform !== 'win32') {
      throw error;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function createLock(file: string, record: LockRecord): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Publish complete metadata atomically. SIGKILL during writing leaves only
  // an unreferenced temporary file, never a truncated authoritative record.
  const temporary = `${file}.${record.token}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    syncDirectory(path.dirname(file));
    return true;
  } finally {
    fs.unlinkSync(temporary);
  }
}

export class FileLock {
  private released = false;

  private constructor(
    readonly file: string,
    private readonly token: string,
    private readonly guardFd?: number,
  ) {}

  private static acquireKernel(file: string, record: LockRecord): FileLock {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(`${file}.guard`, 'a+', 0o600);
    try {
      if (!tryKernelLock(fd)) throw new LockUnavailableError(observeLock(file));
      if (!createLock(file, record)) {
        const previous = readLockRecord(file);
        if (!previous) throw new AmbiguousLockError({ status: 'ambiguous', reason: 'invalid' });
        if (previous.schemaVersion === 1) {
          // A pre-upgrade process does not participate in the kernel lock.
          // Retain its conservative checks and reclamation protocol.
          const reclaim = FileLock.acquire(`${file}.reclaim`);
          try {
            const observation = observeLock(file);
            if (observation.status === 'ambiguous') throw new AmbiguousLockError(observation);
            if (observation.status !== 'stale') throw new LockUnavailableError(observation);
            fs.unlinkSync(file);
            if (!createLock(file, record)) throw new LockUnavailableError(observeLock(file));
          } finally {
            reclaim.release();
          }
        } else {
          // Holding the kernel lock proves that a version-2 owner is gone,
          // irrespective of its PID, hostname, boot or container namespace.
          fs.unlinkSync(file);
          if (!createLock(file, record)) throw new LockUnavailableError(observeLock(file));
        }
      }
      return new FileLock(file, record.token, fd);
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }

  static acquire(file: string): FileLock {
    const record: LockRecord = {
      schemaVersion: process.platform === 'linux' ? 2 : 1,
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      token: crypto.randomUUID(),
    };
    if (process.platform === 'linux') return FileLock.acquireKernel(file, record);
    if (createLock(file, record)) return new FileLock(file, record.token);

    const observation = observeLock(file);
    if (observation.status === 'ambiguous') throw new AmbiguousLockError(observation);
    if (observation.status !== 'stale') throw new LockUnavailableError(observation);

    const reclaimLock = FileLock.acquire(`${file}.reclaim`);
    try {
      const current = observeLock(file);
      if (current.status === 'ambiguous') throw new AmbiguousLockError(current);
      if (current.status !== 'stale') throw new LockUnavailableError(current);
      fs.unlinkSync(file);
      syncDirectory(path.dirname(file));
      if (!createLock(file, record)) throw new LockUnavailableError(observeLock(file));
      return new FileLock(file, record.token);
    } finally {
      reclaimLock.release();
    }
  }

  assertHeld(): void {
    if (this.released || readLockRecord(this.file)?.token !== this.token) {
      throw new Error('This process no longer owns the lock.');
    }
    if (this.guardFd !== undefined) {
      const held = fs.fstatSync(this.guardFd);
      const current = fs.statSync(`${this.file}.guard`);
      if (held.dev !== current.dev || held.ino !== current.ino) {
        throw new Error('This process no longer owns the lock.');
      }
    }
  }

  release(): void {
    if (this.released) return;
    try {
      this.assertHeld();
      fs.unlinkSync(this.file);
      syncDirectory(path.dirname(this.file));
    } finally {
      this.released = true;
      if (this.guardFd !== undefined) fs.closeSync(this.guardFd);
    }
  }
}
