import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Page } from '../src/http/page.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { placeBets, placeBonusBets, placeBetsForMember } from '../src/core.js';
import { readAudit, lastSubmission } from '../src/audit/log.js';
import { mockFetch, page as htmlPage, type MockResponse } from './helpers/mock-fetch.js';

const member = { name: 'Test Member', tipperId: '111', tippsaisonId: '99', dummy: false };
type Kind = 'match' | 'bonus' | 'admin';
const target = ['2', '1', '3', '0'];
function form(kind: Kind, values = ['', '', '', '']): string {
  const action = kind === 'admin' ? '/c/spielleiter/tippsnachtragen?tipperId=111&tippsaisonId=99' : '/c/predict';
  const rows = kind === 'bonus'
    ? ['Champion?', 'Relegated?'].map((question, i) => `<tr><td></td><td>${question}</td><td>
        ${[0, 1].map(j => `<select name="q[${i * 2 + j}].tipp">
          ${['', '0', '1', '2', '3'].map(v => `<option value="${v}" ${values[i * 2 + j] === v ? 'selected' : ''}>${v ? `Team ${v}` : '---'}</option>`).join('')}
        </select>`).join('')}</td></tr>`).join('')
    : ['A', 'C'].map((home, i) => `<tr><td>23.10.26</td><td>${home}</td><td>${i ? 'D' : 'B'}</td><td>
        <input id="r${i}_heimTipp" name="r[${i}].heim" value="${values[i * 2]}">
        <input id="r${i}_gastTipp" name="r[${i}].gast" value="${values[i * 2 + 1]}">
      </td></tr>`).join('');
  return `<div id="kicktipp-content"><form method="post" action="${action}">
    <input type="hidden" name="spieltagIndex" value="3">
    <table id="${kind === 'bonus' ? 'tippabgabeFragen' : 'tippabgabeSpiele'}"><tbody>${rows}</tbody></table>
    <button name="submitbutton" type="submit">save</button></form></div>`;
}
function submit(kind: Kind, page: Page, real = true) {
  if (kind === 'bonus') return placeBonusBets(page, 'c', ['Champion?=Team 2', 'Champion?=Team 1', 'Relegated?=Team 3', 'Relegated?=Team 0'], real);
  const bets = ['A vs B=2:1', 'C vs D=3:0'];
  return kind === 'admin' ? placeBetsForMember(page, 'c', member, bets, 3, real) : placeBets(page, 'c', bets, 3, real);
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-submit-'));
  vi.stubEnv('KICKTIPP_DATA_DIR', tmp);
  vi.stubEnv('KICKTIPP_READ_ONLY', '0');
  // No accidental real network, even if a test forgets to inject its transport.
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Real network forbidden'); }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.each<Kind>(['match', 'bonus', 'admin'])('%s submission', kind => {
  function scenario(post: () => MockResponse, readback: () => MockResponse = () => htmlPage(form(kind))) {
    let attempted = false;
    const { fetchImpl, calls } = mockFetch(req => {
      if (req.method === 'POST') { attempted = true; return post(); }
      if (req.url.includes('/profil/login')) return htmlPage('<form><input type="password"></form>');
      return attempted ? readback() : htmlPage(form(kind));
    });
    return { page: new Page(new CookieJar(), fetchImpl), calls };
  }

  it.each([500, 403, 401])('does not report HTTP %s as submitted', async status => {
    const { page, calls } = scenario(() => ({ status, body: 'Denied' }));
    await expect(submit(kind, page)).rejects.toMatchObject({ outcome: status === 500 ? 'submission_unknown' : 'rejected' });
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
    expect(calls.at(-1)?.method).toBe('GET');
    expect(readAudit('c').map(r => r.outcome)).toEqual(['intent', status === 500 ? 'submission_unknown' : 'rejected']);
    expect(lastSubmission('c')).toBeNull();
  });

  it('rejects a login redirect after session expiry', async () => {
    const login = () => ({ status: 302, location: '/info/profil/login' });
    const { page, calls } = scenario(login, login);
    await expect(submit(kind, page)).rejects.toMatchObject({ outcome: 'rejected' });
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
    expect(readAudit('c').at(-1)?.outcome).toBe('rejected');
  });

  it('recognizes an HTTP 200 login form without a redirect', async () => {
    const login = () => htmlPage('<form><input type="password" name="password"></form>');
    const { page, calls } = scenario(login, login);
    await expect(submit(kind, page)).rejects.toMatchObject({ outcome: 'rejected' });
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
  });

  it.each(['validation error', 'unchanged'])('rejects HTTP 200 with %s', async reason => {
    // Even echoed target values in a POST error response are not saved evidence.
    const { page } = scenario(() => htmlPage(`<p class="error">${reason}</p>${form(kind, target)}`));
    await expect(submit(kind, page)).rejects.toMatchObject({ outcome: 'rejected' });
    expect(readAudit('c').at(-1)?.outcome).toBe('rejected');
  });

  it.each(['normal', 'lost response', 'server error', '307', '308'])('confirms all saved values after %s with one POST', async mode => {
    const { page, calls } = scenario(() => {
      if (mode === 'lost response') throw new Error('Response lost after commit');
      if (mode === 'server error') return { status: 500 };
      if (mode === '307' || mode === '308') return { status: Number(mode), location: '/repeat-post' };
      return htmlPage('Saved');
    }, () => htmlPage(form(kind, target)));
    await expect(submit(kind, page)).resolves.toHaveLength(kind === 'bonus' ? 4 : 2);
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
    expect(calls.at(-1)?.method).toBe('GET');
    expect(calls.at(-1)?.headers.get('cache-control')).toBe('no-cache, no-store');
    expect(readAudit('c').map(r => r.outcome)).toEqual(['intent', 'submitted']);
    if (kind === 'admin') expect(calls.at(-1)?.url).toContain('tipperId=111&tippsaisonId=99&spieltagIndex=3');
    if (kind === 'bonus') expect(calls.at(-1)?.url).toContain('bonus=true');
  });

  it('reconciles a lost redirect GET after the POST committed', async () => {
    let attempted = false;
    const { fetchImpl, calls } = mockFetch(req => {
      if (req.method === 'POST') {
        attempted = true;
        return { status: 303, location: '/receipt' };
      }
      if (req.url.endsWith('/receipt')) throw new Error('Receipt GET lost');
      return htmlPage(form(kind, attempted ? target : undefined));
    });
    await expect(submit(kind, new Page(new CookieJar(), fetchImpl))).resolves.toBeDefined();
    expect(calls.map(c => c.method)).toEqual(['GET', 'POST', 'GET', 'GET']);
    expect(readAudit('c').at(-1)?.outcome).toBe('submitted');
  });

  it('keeps session loss during read-back uncertain after an accepted POST', async () => {
    const { page } = scenario(() => htmlPage('Saved'), () => ({ status: 302, location: '/info/profil/login' }));
    await expect(submit(kind, page)).rejects.toMatchObject({ outcome: 'submission_unknown' });
    expect(readAudit('c').at(-1)?.outcome).toBe('submission_unknown');
  });

  it.each(['403', 'login redirect'])('does not mistake a receipt GET %s for POST rejection', async reason => {
    let stored = false;
    const { fetchImpl, calls } = mockFetch(req => {
      if (req.method === 'POST') {
        stored = true;
        return { status: 303, location: '/receipt' };
      }
      if (req.url.endsWith('/receipt')) return reason === '403'
        ? { status: 403 } : { status: 302, location: '/info/profil/login' };
      if (req.url.includes('/profil/login')) return htmlPage('<input type="password">');
      if (stored) throw new Error('Read-back unavailable after commit');
      return htmlPage(form(kind));
    });
    await expect(submit(kind, new Page(new CookieJar(), fetchImpl))).rejects.toMatchObject({ outcome: 'submission_unknown' });
    expect(stored).toBe(true);
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
    expect(readAudit('c').at(-1)?.outcome).toBe('submission_unknown');
  });

  it('keeps a lost response with unchanged values uncertain', async () => {
    const { page, calls } = scenario(() => { throw new Error('Connection lost'); });
    await expect(submit(kind, page)).rejects.toMatchObject({ outcome: 'submission_unknown' });
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
    expect(readAudit('c').at(-1)?.outcome).toBe('submission_unknown');
  });

  it('does not claim success or complete rejection for a partial save', async () => {
    const { page } = scenario(() => htmlPage('Saved'), () => htmlPage(form(kind, ['2', '1', '', ''])));
    await expect(submit(kind, page)).rejects.toMatchObject({ outcome: 'submission_unknown' });
    expect(readAudit('c').at(-1)?.outcome).toBe('submission_unknown');
    expect(lastSubmission('c')).toBeNull();
  });

  it.each(['missing fields', 'read failure', '500 with target values', 'different matchday'])('keeps %s in readback uncertain', async reason => {
    const { page } = scenario(() => htmlPage('Saved'), () => {
      if (reason === 'read failure') throw new Error('GET failed');
      if (reason === '500 with target values') return { status: 500, body: form(kind, target) };
      if (reason === 'different matchday') return htmlPage(form(kind, target).replace('value="3">', 'value="4">'));
      return htmlPage('<p>Locked or changed markup</p>');
    });
    await expect(submit(kind, page)).rejects.toMatchObject({ outcome: 'submission_unknown' });
    expect(readAudit('c').at(-1)?.outcome).toBe('submission_unknown');
  });

  it('allows a dry run in read-only mode without POST or reconciliation', async () => {
    vi.stubEnv('KICKTIPP_READ_ONLY', '1');
    const { page, calls } = scenario(() => { throw new Error('Must not POST'); });
    await expect(submit(kind, page, false)).resolves.toBeDefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(readAudit('c').map(r => r.outcome)).toEqual(['dry-run']);
  });

  it('blocks real writes before any transport call in read-only mode', async () => {
    vi.stubEnv('KICKTIPP_READ_ONLY', '1');
    const { page, calls } = scenario(() => htmlPage('Saved'));
    await expect(submit(kind, page)).rejects.toThrow(/blocked/);
    expect(calls).toEqual([]);
    expect(readAudit('c')).toEqual([]);
  });

  it.each([500, 403])('does not POST a form served with HTTP %s', async status => {
    const { fetchImpl, calls } = mockFetch(() => ({ status, body: form(kind) }));
    await expect(submit(kind, new Page(new CookieJar(), fetchImpl))).rejects.toThrow(`HTTP ${status}`);
    expect(calls.map(c => c.method)).toEqual(['GET']);
    expect(readAudit('c')).toEqual([]);
  });
});

describe('submission context', () => {
  it.each(['1110', '222'])('does not accept another member id %s before POST', async id => {
    const { fetchImpl, calls } = mockFetch(() => htmlPage(form('admin').replace('tipperId=111', `tipperId=${id}`)));
    await expect(submit('admin', new Page(new CookieJar(), fetchImpl))).rejects.toThrow(/does not carry their tipperId/);
    expect(calls.map(c => c.method)).toEqual(['GET']);
  });

  it('rejects a conflicting hidden member id before POST', async () => {
    const { fetchImpl, calls } = mockFetch(() => htmlPage(form('admin').replace('<table', '<input type="hidden" name="tipperId" value="222"><table')));
    await expect(submit('admin', new Page(new CookieJar(), fetchImpl))).rejects.toThrow(/does not carry their tipperId/);
    expect(calls.map(c => c.method)).toEqual(['GET']);
  });

  it.each(['type="hidden" disabled', 'type="checkbox"', 'type="radio"'])('does not rely on an unsubmitted member id (%s)', async attributes => {
    const html = form('admin').replace('?tipperId=111&tippsaisonId=99', '')
      .replace('<table', `<input ${attributes} name="tipperId" value="111"><table`);
    const { fetchImpl, calls } = mockFetch(() => htmlPage(html));
    await expect(submit('admin', new Page(new CookieJar(), fetchImpl))).rejects.toThrow(/does not carry their tipperId/);
    expect(calls.map(c => c.method)).toEqual(['GET']);
  });

  it('supports a member id carried by an enabled hidden control', async () => {
    let attempted = false;
    const { fetchImpl, calls } = mockFetch(req => {
      if (req.method === 'POST') { attempted = true; return htmlPage('saved'); }
      return htmlPage(form('admin', attempted ? target : undefined)
        .replace('?tipperId=111&tippsaisonId=99', '')
        .replace('<table', '<input type="hidden" name="tipperId" value="111"><table'));
    });
    await expect(submit('admin', new Page(new CookieJar(), fetchImpl))).resolves.toBeDefined();
    expect(new URLSearchParams(calls.find(c => c.method === 'POST')?.body || '').get('tipperId')).toBe('111');
  });

  it.each(['tipperId', 'spieltagIndex'])('does not let the request URL mask a lost form %s', async key => {
    let attempted = false;
    const { fetchImpl } = mockFetch(req => {
      if (req.method === 'POST') { attempted = true; return htmlPage('saved'); }
      let html = form('admin', attempted ? target : undefined);
      if (attempted) html = key === 'tipperId'
        ? html.replace('tipperId=111&', '')
        : html.replace('<input type="hidden" name="spieltagIndex" value="3">', '');
      return htmlPage(html);
    });
    await expect(submit('admin', new Page(new CookieJar(), fetchImpl))).rejects.toMatchObject({ outcome: 'submission_unknown' });
  });

  it('does not confirm another member even when all goal fields match', async () => {
    let attempted = false;
    const { fetchImpl, calls } = mockFetch(req => {
      if (req.method === 'POST') { attempted = true; return htmlPage('saved'); }
      return htmlPage(attempted ? form('admin', target).replace('tipperId=111', 'tipperId=222') : form('admin'));
    });
    await expect(submit('admin', new Page(new CookieJar(), fetchImpl))).rejects.toMatchObject({ outcome: 'submission_unknown' });
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
  });

  it('pins the inferred matchday when none was requested', async () => {
    let attempted = false;
    const { fetchImpl, calls } = mockFetch(req => {
      if (req.method === 'POST') { attempted = true; return htmlPage('saved'); }
      return htmlPage(form('match', attempted ? target : undefined));
    });
    await placeBets(new Page(new CookieJar(), fetchImpl), 'c', ['A vs B=2:1', 'C vs D=3:0']);
    expect(calls[0].url).not.toContain('spieltagIndex');
    expect(calls.at(-1)?.url).toContain('spieltagIndex=3');
  });

  it('refuses an empty submission without a POST', async () => {
    const { fetchImpl, calls } = mockFetch(() => htmlPage(form('match')));
    await expect(placeBets(new Page(new CookieJar(), fetchImpl), 'c', [])).rejects.toThrow(/nonempty/);
    expect(calls.map(c => c.method)).toEqual(['GET']);
    expect(readAudit('c').at(-1)?.outcome).toMatch(/^failed:/);
  });
});
