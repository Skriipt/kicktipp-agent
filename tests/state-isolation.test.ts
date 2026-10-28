import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp: string;
let config: typeof import('../src/config.js');
let storeModule: typeof import('../src/cache/store.js');
let audit: typeof import('../src/audit/log.js');
let urls: typeof import('../src/url.js');
let configFile: string;

const record = {
  at: '2026-10-28T12:00:00Z', source: 'cli:bet' as const, community: 'shared',
  matchday: 1, kind: 'match' as const, dryRun: false,
  bets: [{ fixture: 'A vs B', bet: '3:0', previous: '2:1' }], outcome: 'submitted' as const,
};
const snapshot = { title: 'Alice bets', matches: [] };

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-identity-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  vi.stubEnv('KICKTIPP_DATA_DIR', path.join(tmp, 'data'));
  vi.stubEnv('KICKTIPP_PROFILE', '');
  vi.stubEnv('KICKTIPP_EMAIL', '');
  vi.stubEnv('KICKTIPP_PASSWORD', '');
  configFile = path.join(tmp, '.config', 'kicktipp-agent', 'config.ini');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, '[profile.alice]\nemail=alice@example.com\nstore=session\n[profile.bob]\nemail=bob@example.com\nstore=session\n');
  vi.resetModules();
  config = await import('../src/config.js');
  storeModule = await import('../src/cache/store.js');
  audit = await import('../src/audit/log.js');
  urls = await import('../src/url.js');
  urls.setUrlBase('https://www.kicktipp.com');
  config.setActiveProfile('alice');
});

afterEach(() => {
  config.setActiveProfile(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('persistent account identity', () => {
  it('isolates both personal snapshots and undo history between profiles', () => {
    const alice = new storeModule.CacheStore('shared');
    alice.write('bets', snapshot, 1);
    audit.appendAudit(record);
    expect(audit.lastSubmission('shared')?.bets[0].previous).toBe('2:1');
    config.setActiveProfile('bob');
    const bob = new storeModule.CacheStore('shared');
    expect(bob.read('bets', 1)).toBeNull();
    expect(audit.lastSubmission('shared')).toBeNull();
    expect(audit.readAudit('shared')).toEqual([]);
    expect(bob.dir).not.toBe(alice.dir);
    config.setActiveProfile('alice');
    expect(audit.lastSubmission('shared')?.bets[0].previous).toBe('2:1');
  });

  it('invalidates account ownership when the account changes inside one profile', () => {
    const previous = new storeModule.CacheStore('shared');
    const previousSession = config.sessionFile();
    fs.writeFileSync(previousSession, '{"cookies":[]}');
    previous.write('bets', snapshot, 1);
    audit.appendAudit(record);
    fs.writeFileSync(configFile, '[profile.alice]\nemail=replacement@example.com\nstore=session\n');
    expect(new storeModule.CacheStore('shared').read('bets', 1)).toBeNull();
    expect(audit.lastSubmission('shared')).toBeNull();
    expect(config.sessionFile()).not.toBe(previousSession);
    expect(fs.readFileSync(previousSession, 'utf8')).toBe('{"cookies":[]}');
  });

  it('isolates environment credential accounts and different site origins', () => {
    vi.stubEnv('KICKTIPP_EMAIL', 'override@example.com');
    vi.stubEnv('KICKTIPP_PASSWORD', 'not-a-real-secret');
    const first = new storeModule.CacheStore('shared');
    const firstSession = config.sessionFile();
    first.write('bets', snapshot, 1);
    audit.appendAudit(record);
    vi.stubEnv('KICKTIPP_EMAIL', 'different@example.com');
    expect(new storeModule.CacheStore('shared').read('bets', 1)).toBeNull();
    expect(audit.lastSubmission('shared')).toBeNull();
    expect(config.sessionFile()).not.toBe(firstSession);
    vi.stubEnv('KICKTIPP_EMAIL', 'override@example.com');
    urls.setUrlBase('https://www.kicktipp.de');
    expect(new storeModule.CacheStore('shared').read('bets', 1)).toBeNull();
    expect(audit.lastSubmission('shared')).toBeNull();
    expect(config.sessionFile()).not.toBe(firstSession);
    expect(first.dir).not.toContain('override@example.com');
  });

  it('leaves legacy files intact and refuses unattributed or foreign undo records', () => {
    const legacyCache = path.join(tmp, 'data', 'cache', 'shared', 'matchday-01', 'bets.json');
    const legacyLog = path.join(tmp, 'data', 'audit', 'shared.jsonl');
    fs.mkdirSync(path.dirname(legacyCache), { recursive: true });
    fs.mkdirSync(path.dirname(legacyLog), { recursive: true });
    const legacyData = JSON.stringify({ schemaVersion: 1, community: 'shared', kind: 'bets', matchday: 1, data: snapshot });
    fs.writeFileSync(legacyCache, legacyData);
    fs.writeFileSync(legacyLog, JSON.stringify(record) + '\n');
    expect(new storeModule.CacheStore('shared').read('bets', 1)).toBeNull();
    expect(audit.lastSubmission('shared')).toBeNull();
    expect(fs.readFileSync(legacyCache, 'utf8')).toBe(legacyData);
    expect(fs.readFileSync(legacyLog, 'utf8')).toBe(JSON.stringify(record) + '\n');
    expect(audit.isOwnMatchSubmission(record)).toBe(false);
    audit.appendAudit(record);
    const aliceRecord = audit.lastSubmission('shared')!;
    config.setActiveProfile('bob');
    expect(audit.isOwnMatchSubmission(aliceRecord)).toBe(false);
  });

  it('supports environment-only credentials with a named profile', () => {
    config.setActiveProfile('environment-only');
    vi.stubEnv('KICKTIPP_EMAIL', 'env@example.com');
    vi.stubEnv('KICKTIPP_PASSWORD', 'not-a-real-secret');
    expect(() => new storeModule.CacheStore('shared')).not.toThrow();
    expect(config.sessionFile()).toMatch(/session-[a-f0-9]{64}\.json$/);
  });
});
