import path from 'path';
import crypto from 'crypto';
import { authDataDir } from './auth-paths.js';
import { FileLock, LockUnavailableError } from './service/lock.js';

const POLL_MS = 25;
const TIMEOUT_MS = 30_000;
const queues = new Map<string, Promise<void>>();

function lockFile(profileId: string | null): string {
  const id = crypto.createHash('sha256').update(profileId ?? 'default').digest('hex').slice(0, 16);
  return path.join(authDataDir(), `auth-${id}.lock`);
}

async function acquire(file: string): Promise<() => void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (true) {
    try {
      const lock = FileLock.acquire(file);
      return () => lock.release();
    } catch (error) {
      if (!(error instanceof LockUnavailableError)) throw error;
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for Auth Profile session mutation.');
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
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
