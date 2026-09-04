import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';

const lockRecordSchema = z.object({
  schemaVersion: z.literal(1),
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

export function observeLock(file: string): LockObservation {
  if (!fs.existsSync(file)) return { status: 'absent' };
  const record = readLockRecord(file);
  if (!record) return { status: 'ambiguous', reason: 'invalid' };
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

function syncDirectory(dir: string): void {
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
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    syncDirectory(path.dirname(file));
    return true;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve the original failure */ }
    }
    try { fs.unlinkSync(file); } catch { /* preserve the original failure */ }
    throw error;
  }
}

export class FileLock {
  private released = false;

  private constructor(
    readonly file: string,
    private readonly token: string,
  ) {}

  static acquire(file: string): FileLock {
    const record: LockRecord = {
      schemaVersion: 1,
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: new Date().toISOString(),
      token: crypto.randomUUID(),
    };
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
  }

  release(): void {
    if (this.released) return;
    this.assertHeld();
    fs.unlinkSync(this.file);
    this.released = true;
    syncDirectory(path.dirname(this.file));
  }
}
