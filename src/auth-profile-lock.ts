import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'kicktipp-agent');
const POLL_MS = 25;
const TIMEOUT_MS = 30_000;
const queues = new Map<string, Promise<void>>();

function lockFile(profileId: string | null): string {
  const id = crypto.createHash('sha256').update(profileId ?? 'default').digest('hex').slice(0, 16);
  return path.join(CONFIG_DIR, `auth-${id}.lock`);
}

function ownerIsDead(file: string): boolean {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function tryAcquire(file: string): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const reaper = `${file}.reap`;
  if (fs.existsSync(reaper)) return false;
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      fs.writeFileSync(reaper, String(process.pid), { flag: 'wx', mode: 0o600 });
    } catch (reaperError) {
      if ((reaperError as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw reaperError;
    }
    try {
      if (ownerIsDead(file)) fs.unlinkSync(file);
    } finally {
      fs.unlinkSync(reaper);
    }
    return false;
  }
}

async function acquire(file: string): Promise<() => void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!tryAcquire(file)) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for Auth Profile session mutation.');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return () => {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
}

/** Serialize credential and session mutations without blocking ordinary reads. */
export async function withAuthProfileMutation<T>(
  profileId: string | null,
  mutation: () => Promise<T> | T,
): Promise<T> {
  const file = lockFile(profileId);
  const previous = queues.get(file) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const queued = new Promise<void>((resolve) => { releaseQueue = resolve; });
  queues.set(file, queued);
  await previous;

  let releaseFile: (() => void) | undefined;
  try {
    releaseFile = await acquire(file);
    return await mutation();
  } finally {
    try {
      releaseFile?.();
    } finally {
      releaseQueue();
      if (queues.get(file) === queued) queues.delete(file);
    }
  }
}
