import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setActiveProfile } from '../src/config.js';
import { setUrlBase, urlBase } from '../src/url.js';
import { CacheStore } from '../src/cache/store.js';
import { appendAudit, lastSubmission, readAudit, auditFile } from '../src/audit/log.js';

let temp: string, site: string;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-scope-'));
  site = urlBase();
  vi.stubEnv('KICKTIPP_DATA_DIR', temp);
});
afterEach(() => {
  setActiveProfile(null);
  setUrlBase(site);
  vi.unstubAllEnvs();
  fs.rmSync(temp, { recursive: true, force: true });
});

it('isolates audit and cached own tips across profiles, accounts and sites', () => {
  setActiveProfile('alpha');
  const cache = new CacheStore('family');
  cache.write('bets', { title: 'Alpha', matches: [] }, 1);
  appendAudit({ at: new Date().toISOString(), community: 'family', source: 'cli:bet',
    kind: 'match', dryRun: false, matchday: 1, outcome: 'submitted',
    bets: [{ fixture: 'A vs B', bet: '2:1', previous: '1:0' }] });
  for (const change of [
    () => setActiveProfile('beta'),
    () => { setActiveProfile('alpha'); setUrlBase('https://www.kicktipp.de'); },
    () => { setUrlBase(site); vi.stubEnv('KICKTIPP_EMAIL', 'new@example.com'); vi.stubEnv('KICKTIPP_PASSWORD', 'test'); },
  ]) {
    change();
    expect(new CacheStore('family').read('bets', 1)).toBeNull();
    expect(lastSubmission('family')).toBeNull();
  }
  vi.unstubAllEnvs(); vi.stubEnv('KICKTIPP_DATA_DIR', temp);
  expect(new CacheStore('family').read('bets', 1)?.data.title).toBe('Alpha');
  expect(lastSubmission('family')?.bets[0].previous).toBe('1:0');
});

it('preserves legacy shared files without treating them as this account history', () => {
  fs.mkdirSync(path.join(temp, 'audit'));
  const legacy = path.join(temp, 'audit', 'family.jsonl');
  fs.writeFileSync(legacy, '{"outcome":"submitted"}\n');
  expect(readAudit('family')).toEqual([]);
  expect(fs.readFileSync(legacy, 'utf8')).toContain('submitted');
  expect(auditFile('family')).not.toBe(legacy);
});
