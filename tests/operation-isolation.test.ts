import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Page, getCommunities, getPlayers, launchBrowser } from '../src/browser.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { fetchBets, placeBets, placeBetsForMember, AuthError } from '../src/core.js';
import { fetchTipStatus } from '../src/tip-status.js';

let temporary: string;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-operation-'));
  vi.stubEnv('KICKTIPP_DATA_DIR', temporary);
  vi.stubEnv('KICKTIPP_READ_ONLY', '0');
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(temporary, { recursive: true, force: true });
});

function form(admin: boolean, day: number, goals = ['', '']) {
  const action = admin ? '/c/spielleiter/tippsnachtragen?tipperId=111&tippsaisonId=99' : '/c/predict';
  return `<div id="kicktipp-content"><div class="pagetitle">Day ${day}</div>
    <form method="post" action="${action}"><input name="spieltagIndex" type="hidden" value="${day}">
    <table id="tippabgabeSpiele"><tbody><tr><td>23.10.26</td><td>A</td><td>B</td><td>
    <input id="r0_heimTipp" name="r[0].heim" value="${goals[0]}">
    <input id="r0_gastTipp" name="r[0].gast" value="${goals[1]}">
    </td></tr></tbody></table><button name="submitbutton" type="submit">Save</button></form></div>`;
}

describe('shared session operations', () => {
  it('keeps concurrently requested matchdays separate', async () => {
    const page = new Page(new CookieJar(), async (url) =>
      new Response(form(false, Number(new URL(url).searchParams.get('spieltagIndex')))));
    const [second, third] = await Promise.all([fetchBets(page, 'c', 2), fetchBets(page, 'c', 3)]);
    expect(second.title).toBe('Day 2');
    expect(third.title).toBe('Day 3');
  });

  it('submits and verifies simultaneous own and admin bets against their respective accounts', async () => {
    const saved = new Map<string, string[]>();
    const posted: string[] = [];
    const page = new Page(new CookieJar(), async (url, init) => {
      const admin = new URL(url).searchParams.get('tipperId') === '111';
      const account = admin ? 'member' : 'own';
      if (init.method === 'POST') {
        const body = new URLSearchParams(String(init.body));
        saved.set(account, [body.get('r[0].heim')!, body.get('r[0].gast')!]);
        posted.push(account);
        return new Response('Saved');
      }
      return new Response(form(admin, 3, saved.get(account)));
    });
    const member = { name: 'Member', tipperId: '111', tippsaisonId: '99', dummy: false };
    await Promise.all([
      placeBets(page, 'c', ['A vs B=2:1'], 3),
      placeBetsForMember(page, 'c', member, ['A vs B=3:0'], 3),
    ]);
    expect(posted).toEqual(['own', 'member']);
    expect(saved.get('own')).toEqual(['2', '1']);
    expect(saved.get('member')).toEqual(['3', '0']);
  });

  it('lets the next request proceed after an operation fails', async () => {
    const page = new Page(new CookieJar(), async url => new URL(url).searchParams.get('spieltagIndex') === '2'
      ? new Response('Unavailable', { status: 500 }) : new Response(form(false, 3)));
    const [failed, succeeding] = await Promise.allSettled([fetchBets(page, 'c', 2), fetchBets(page, 'c', 3)]);
    expect(failed.status).toBe('rejected');
    expect(succeeding).toMatchObject({ status: 'fulfilled', value: { title: 'Day 3' } });
  });

  it('finishes an in-flight submission and its read-back before closing', async () => {
    let posted!: () => void;
    let release!: () => void;
    const postStarted = new Promise<void>(resolve => { posted = resolve; });
    const finishPost = new Promise<void>(resolve => { release = resolve; });
    let saved = false;
    const page = new Page(new CookieJar(), async (_url, init) => {
      if (init.method === 'POST') {
        posted();
        await finishPost;
        saved = true;
        return new Response('Saved');
      }
      return new Response(form(false, 3, saved ? ['2', '1'] : ['', '']));
    });
    const submission = placeBets(page, 'c', ['A vs B=2:1'], 3);
    await postStarted;
    const closing = page.close();
    await expect(fetchBets(page, 'c', 4)).rejects.toThrow(/closed/);
    release();
    await expect(submission).resolves.toHaveLength(1);
    await closing;
    await expect(page.content()).rejects.toThrow(/closed/);
  });
});

describe('browser helpers preserve failures', () => {
  it.each([401, 403, 500])('rejects HTTP %s instead of returning empty lists', async status => {
    const page = new Page(new CookieJar(), async () => new Response('Denied', { status }));
    await expect(getCommunities(page)).rejects.toThrow();
    await expect(getPlayers(page, 'c')).rejects.toThrow();
    await expect(fetchTipStatus(page, 'c')).rejects.toThrow();
  });

  it('classifies expired player and tip-status reads as authentication failures', async () => {
    const page = new Page(new CookieJar(), async () => new Response('<input type="password">'));
    await expect(getPlayers(page, 'c')).rejects.toBeInstanceOf(AuthError);
    await expect(fetchTipStatus(page, 'c')).rejects.toBeInstanceOf(AuthError);
  });

  it('does not accept or silently reauthenticate an HTTP 500 session restore', async () => {
    const file = path.join(temporary, 'session.json');
    fs.writeFileSync(file, JSON.stringify(new CookieJar().toJSON()));
    const requests: string[] = [];
    await expect(launchBrowser({ sessionFile: file, fetchImpl: async url => {
      requests.push(url);
      return new Response('Unavailable', { status: 500 });
    } })).rejects.toThrow(/HTTP 500/);
    expect(requests).toHaveLength(1);
  });
});
