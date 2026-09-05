import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Page } from '../src/http/page.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { placeBets } from '../src/core.js';
import { appendAudit, readAudit, lastSubmission, auditFile } from '../src/audit/log.js';
import { mockFetch, page as htmlPage } from './helpers/mock-fetch.js';

let tmp: string;

const FORM = (bet = '') => {
  const [h, g] = bet ? bet.split(':') : ['', ''];
  return `<div id="kicktipp-content"><form method="post" action="/c/tippabgabe">
    <table id="tippabgabeSpiele"><tbody><tr>
      <td>21.08.26 20:30</td><td>Bayern</td><td>BVB</td>
      <td><input id="r1_heimTipp" name="r1_heimTipp" value="${h}"><input id="r1_gastTipp" name="r1_gastTipp" value="${g}"></td>
      <td></td></tr></tbody></table>
    <button type="submit" name="submitbutton" value="save">save</button></form></div>`;
};

function betPage(existing = '') {
  const { fetchImpl, calls } = mockFetch((req) =>
    req.method === 'GET' ? htmlPage(FORM(existing)) : htmlPage('saved'),
  );
  return { page: new Page(new CookieJar(), fetchImpl), calls };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-audit-'));
  vi.stubEnv('KICKTIPP_DATA_DIR', tmp);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the audit file', () => {
  it('appends one JSON object per line', () => {
    const base = {
      at: '2026-08-21T12:00:00.000Z',
      source: 'cli:bet' as const,
      community: 'c',
      matchday: 1,
      kind: 'match' as const,
      dryRun: false,
      bets: [{ fixture: 'A vs B', bet: '2:1', previous: null }],
    };
    appendAudit({ ...base, outcome: 'submitted' });
    appendAudit({ ...base, outcome: 'dry-run' });

    const lines = fs.readFileSync(auditFile('c'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).outcome).toBe('submitted');
    expect(readAudit('c')).toHaveLength(2);
  });

  it('is written owner-only where POSIX modes are available', () => {
    appendAudit({
      at: '', source: 'cli:bet', community: 'c', matchday: null,
      kind: 'match', dryRun: false, bets: [], outcome: 'submitted',
    });
    if (process.platform !== 'win32') {
      expect(fs.statSync(auditFile('c')).mode & 0o777).toBe(0o600);
    }
  });

  it('skips a corrupt line rather than failing the read', () => {
    fs.mkdirSync(path.dirname(auditFile('c')), { recursive: true });
    fs.writeFileSync(auditFile('c'), '{"broken\nnot json\n');
    expect(readAudit('c')).toEqual([]);
  });

  it('returns nothing for a community with no log', () => {
    expect(readAudit('never-used')).toEqual([]);
    expect(lastSubmission('never-used')).toBeNull();
  });

  it('warns but does not throw when the file cannot be written', () => {
    const blocker = path.join(tmp, 'blocked');
    fs.writeFileSync(blocker, 'a file where the directory should be');
    vi.stubEnv('KICKTIPP_DATA_DIR', blocker);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      appendAudit({
        at: '', source: 'cli:bet', community: 'c', matchday: null,
        kind: 'match', dryRun: false, bets: [], outcome: 'submitted',
      }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not write the bet log/));
  });
});

describe('placeBets records every attempt', () => {
  it.each([404, 429, 500, 503])('does not mark an HTTP %s submission as successful', async (status) => {
    const { fetchImpl } = mockFetch((req) => req.method === 'GET'
      ? htmlPage(FORM()) : { status, body: 'failed' });
    await expect(placeBets(new Page(new CookieJar(), fetchImpl), 'c', ['Bayern vs BVB=2:1']))
      .rejects.toThrow();
    expect(readAudit('c').map((record) => record.outcome)).toEqual(['intent', expect.stringMatching(/^failed:/)]);
    expect(lastSubmission('c')).toBeNull();
  });

  it('writes intent then submitted, with the source', async () => {
    const { page } = betPage();
    await placeBets(page, 'c', ['Bayern vs BVB=2:1'], 3, true, 'mcp:place_bets');

    const records = readAudit('c');
    expect(records.map((r) => r.outcome)).toEqual(['intent', 'submitted']);
    expect(records[1]).toMatchObject({
      source: 'mcp:place_bets',
      matchday: 3,
      kind: 'match',
      dryRun: false,
    });
    expect(records[1].bets).toEqual([{ fixture: 'Bayern vs BVB', bet: '2:1', previous: null }]);
  });

  it('captures the bet it replaced, so it can be undone', async () => {
    const { page } = betPage('1:1');
    await placeBets(page, 'c', ['Bayern vs BVB=3:0'], 3, true, 'cli:bet');

    const last = lastSubmission('c');
    expect(last?.bets[0]).toEqual({ fixture: 'Bayern vs BVB', bet: '3:0', previous: '1:1' });
  });

  it('records a dry run as such and submits nothing', async () => {
    const { page, calls } = betPage();
    await placeBets(page, 'c', ['Bayern vs BVB=2:1'], 3, false, 'cli:suggest');

    expect(readAudit('c').map((r) => r.outcome)).toEqual(['dry-run']);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    // A dry run is not a submission, so undo must not offer it.
    expect(lastSubmission('c')).toBeNull();
  });

  it('records a failure with its reason', async () => {
    const { fetchImpl } = mockFetch((req) => {
      if (req.method === 'GET') return htmlPage(FORM());
      throw new Error('network died');
    });
    const page = new Page(new CookieJar(), fetchImpl);

    await expect(placeBets(page, 'c', ['Bayern vs BVB=2:1'], 3, true, 'cli:bet')).rejects.toThrow();
    const outcomes = readAudit('c').map((r) => r.outcome);
    expect(outcomes[0]).toBe('intent');
    expect(outcomes[1]).toMatch(/^failed:/);
    expect(lastSubmission('c')).toBeNull();
  });

  it('keeps communities in separate files', async () => {
    const a = betPage();
    await placeBets(a.page, 'one', ['Bayern vs BVB=2:1'], 1, true, 'cli:bet');
    expect(readAudit('two')).toEqual([]);
    expect(readAudit('one')).toHaveLength(2);
  });
});

describe('lastSubmission', () => {
  it('returns the most recent submitted record, filtered by matchday', async () => {
    const first = betPage();
    await placeBets(first.page, 'c', ['Bayern vs BVB=1:0'], 1, true, 'cli:bet');
    const second = betPage();
    await placeBets(second.page, 'c', ['Bayern vs BVB=2:0'], 2, true, 'cli:bet');

    expect(lastSubmission('c')?.bets[0].bet).toBe('2:0');
    expect(lastSubmission('c', 1)?.bets[0].bet).toBe('1:0');
    expect(lastSubmission('c', 9)).toBeNull();
  });

  it('skips bonus and Spielleiter submissions when choosing what to undo', () => {
    const base = {
      community: 'c',
      dryRun: false,
      outcome: 'submitted' as const,
    };
    appendAudit({
      ...base,
      at: '2026-08-21T12:00:00.000Z',
      source: 'cli:bet',
      matchday: 3,
      kind: 'match',
      bets: [{ fixture: 'A vs B', bet: '2:1', previous: '1:1' }],
    });
    appendAudit({
      ...base,
      at: '2026-08-21T12:01:00.000Z',
      source: 'mcp:place_bonus_bets',
      matchday: null,
      kind: 'bonus',
      bets: [{ fixture: 'Champion', bet: 'Bayern', previous: null }],
    });
    appendAudit({
      ...base,
      at: '2026-08-21T12:02:00.000Z',
      source: 'mcp:place_bets_for_member',
      matchday: 3,
      kind: 'match',
      bets: [{ fixture: 'A vs B', bet: '3:0', previous: '0:0' }],
      onBehalfOf: 'Oma',
    });

    expect(lastSubmission('c')).toMatchObject({ source: 'cli:bet', kind: 'match' });
  });
});
