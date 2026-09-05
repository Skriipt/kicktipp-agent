import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { AmbiguousLockError, FileLock, LockUnavailableError, observeLock } from '../src/service/lock.js';

let root: string;
let file: string;
const moduleUrl = new URL('../dist/service/lock.js', import.meta.url).href;
let children: ChildProcess[];
beforeEach(() => {
  children = [];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-lock-'));
  file = path.join(root, 'owner.lock');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(children.map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
  }));
  fs.rmSync(root, { recursive: true, force: true });
});
function editRecord(edit: (record: { pid: number; hostname: string; token: string; schemaVersion: number }) => void): void {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(record);
  fs.writeFileSync(file, JSON.stringify(record));
}
function child(mode = 'hold'): ChildProcess {
  const process = fork(fileURLToPath(new URL('./helpers/service-lock-child.mjs', import.meta.url)),
    [moduleUrl, file, mode], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  children.push(process);
  return process;
}
async function owner(): Promise<ChildProcess> {
  const process = child();
  const [message] = await once(process, 'message');
  expect(message.status).toBe('held');
  return process;
}
async function crash(process: ChildProcess): Promise<void> {
  const exit = once(process, 'exit');
  process.kill('SIGKILL');
  await exit;
}

describe.skipIf(process.platform !== 'linux')('Linux kernel lock ownership', () => {
  it('reclaims after a real SIGKILL even when the recorded PID exists and hostname changed', async () => {
    const processOwner = await owner();
    await crash(processOwner);
    editRecord((record) => { record.pid = process.pid; record.hostname = 'previous-container-hostname'; });
    expect(observeLock(file).status).toBe('stale');
    const replacement = FileLock.acquire(file);
    expect(observeLock(file).status).toBe('held');
    replacement.release();
  });

  it('excludes a real owner despite hostname/PID metadata changes', async () => {
    await owner();
    editRecord((record) => { record.hostname = 'different-container'; record.pid = 999999; });
    expect(observeLock(file).status).toBe('held');
    expect(() => FileLock.acquire(file)).toThrow(LockUnavailableError);
  });

  it('allows exactly one concurrent contender to recover a crashed owner', async () => {
    await crash(await owner());
    const contenders = Array.from({ length: 6 }, () => child());
    const messages = await Promise.all(contenders.map(async (process) => (await once(process, 'message'))[0]));
    expect(messages.filter((message) => message.status === 'held')).toHaveLength(1);
    expect(messages.filter((message) => message.status === 'LockUnavailableError')).toHaveLength(5);
    expect(observeLock(file).status).toBe('held');
  }, 15000);

  it.each([false, true])('recovers from SIGKILL partway through writing metadata (existing=%s)', async (existing) => {
    if (existing) await crash(await owner());
    const writer = child('crash-writing');
    const [, signal] = await once(writer, 'exit');
    expect(signal).toBe('SIGKILL');
    expect(fs.existsSync(file)).toBe(existing);
    if (existing) expect(observeLock(file).status).toBe('stale');
    const replacement = FileLock.acquire(file);
    replacement.release();
  });

  it('keeps a stable guard inode across release and repeated acquisitions', () => {
    const first = FileLock.acquire(file);
    const inode = fs.statSync(`${file}.guard`).ino;
    first.release();
    const second = FileLock.acquire(file);
    expect(fs.statSync(`${file}.guard`).ino).toBe(inode);
    expect(() => FileLock.acquire(file)).toThrow(LockUnavailableError);
    second.release();
  });

  it('observes through read-only opens without changing file bytes or mtime', () => {
    const lock = FileLock.acquire(file);
    const before = [file, `${file}.guard`].map((name) => ({ bytes: fs.readFileSync(name), mtime: fs.statSync(name).mtimeMs }));
    const open = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation((name, flags, mode) => {
      expect(flags).toBe('r');
      return open(name, flags, mode);
    });
    expect(observeLock(file).status).toBe('held');
    expect([file, `${file}.guard`].map((name) => ({ bytes: fs.readFileSync(name), mtime: fs.statSync(name).mtimeMs }))).toEqual(before);
    vi.restoreAllMocks();
    lock.release();
  });

  it('fails closed when flock is unavailable', () => {
    const oldPath = process.env.PATH;
    process.env.PATH = root;
    try {
      expect(() => FileLock.acquire(file)).toThrow(AmbiguousLockError);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      process.env.PATH = oldPath;
    }
    const lock = FileLock.acquire(file);
    lock.release();
  });

  it('does not reclaim a foreign legacy owner or an existing legacy PID', () => {
    const legacy = { schemaVersion: 1, pid: process.pid, hostname: 'old-container', token: 'legacy', startedAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(legacy));
    expect(() => FileLock.acquire(file)).toThrow(AmbiguousLockError);
    editRecord((record) => { record.hostname = os.hostname(); });
    expect(() => FileLock.acquire(file)).toThrow(LockUnavailableError);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).token).toBe('legacy');
  });

  it('does not delete replacement metadata when a token was changed', () => {
    const lock = FileLock.acquire(file);
    editRecord((record) => { record.token = 'replacement'; });
    expect(() => lock.release()).toThrow(/no longer owns/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).token).toBe('replacement');
    const next = FileLock.acquire(file);
    next.release();
  });
});
