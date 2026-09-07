import { afterEach, describe, expect, it, vi } from 'vitest';
import { Page } from '../src/http/page.js';
import { fetchWorkflowFixtures, KicktippSubmissionAdapter } from '../src/workflow/kicktipp.js';

const scope = { profile: 'test', community: 'test', season: '2026', competition: 'bundesliga', providerSeasonId: '5530388' };
const kickoff = Date.parse('2026-09-11T18:30:00Z');
const { providerSeasonId, ...identity } = scope;
const fixture = { ...identity, fixtureId: '123', matchday: '3', home: 'Union', away: 'Schalke', kickoff };
const context = () => ({ signal: new AbortController().signal, now: () => kickoff - 60_000 });
const row = (id = '123', home = 'Union', score = ['', '']) => `<tr><td>11.09.26 20:30</td><td>${home}</td><td>Schalke</td><td><input id="spieltippForms_${id}_heimTipp" name="spieltippForms[${id}].heimTipp" value="${score[0]}"><input id="spieltippForms_${id}_gastTipp" name="spieltippForms[${id}].gastTipp" value="${score[1]}"></td></tr>`;
const html = (content = row()) => `<div id="kicktipp-content"><form method="post"><input type="hidden" name="tippsaisonId" value="5530388"><input type="hidden" name="spieltippForms[123].tippAbgegeben" value="true"><input type="hidden" name="spieltagIndex" value="3"><input type="hidden" name="_csrf" value="safe"><input type="hidden" name="bonus" value="true"><table id="tippabgabeSpiele"><tbody>${content}</tbody></table><table id="tippabgabeFragen"><select name="bonusAnswer"><option selected value="1"></option></select></table><button name="submitbutton" value="save">Save</button></form></div>`;
const scheduleRow = (id = '123', home = 'Union') => `<tr data-url="/test/tippspielplan/spiel?tippsaisonId=5530388&amp;tippspielId=${id}"><td>11.09.26 20:30</td><td>11.09.26 20:30</td><td>${home}</td><td>Schalke</td><td>-:-</td></tr>`;
const schedule = (content = scheduleRow() + scheduleRow('456', 'Bayern')) => `<div class="prevnextTitle">3. Spieltag</div><table id="spiele"><tbody>${content}</tbody></table>`;
function fake(content = html(), postStatus = 200, scheduleHtml = schedule()) {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => new Response(/\/(schedule|tippspielplan)(?:\?|$)/.test(_url) ? scheduleHtml : content, { status: init.method === 'POST' ? postStatus : 200, headers: postStatus === 307 && init.method === 'POST' ? { location: '/test/predict' } : {} }));
  return { page: new Page(undefined, fetch), fetch };
}
afterEach(() => vi.unstubAllEnvs());
describe('workflow Kicktipp transport', () => {
  it('imports internal form identity and server-zone kickoff', async () => {
    const { page } = fake();
    expect(await fetchWorkflowFixtures(page, scope, 3)).toEqual([fixture, { ...fixture, fixtureId: '456', home: 'Bayern' }]);
  });
  it.each([
    schedule(scheduleRow() + scheduleRow()), schedule().replace('tippspielId=123', 'missingId=123'),
    schedule().replace('3. Spieltag', '4. Spieltag'), schedule().replaceAll('11.09.26 20:30', '25.10.26 02:30'),
    schedule().replaceAll('tippsaisonId=5530388', 'tippsaisonId=999'),
  ])('fails closed on ambiguous or absent identity/date', async content => {
    await expect(fetchWorkflowFixtures(fake(html(), 200, content).page, scope, 3)).rejects.toThrow();
  });
  it('posts exactly one match and known hidden tokens, no bonus or other match', async () => {
    const { page, fetch } = fake(html(row() + row('456', 'Bayern')));
    await new KicktippSubmissionAdapter(scope, async () => page).submit(fixture, { home: 2, away: 1 }, context());
    const posts = fetch.mock.calls.filter(([, init]) => init.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(Object.fromEntries(posts[0][1].body as URLSearchParams)).toEqual({ spieltagIndex: '3', tippsaisonId: '5530388', 'spieltippForms[123].tippAbgegeben': 'true', _csrf: 'safe', 'spieltippForms[123].heimTipp': '2', 'spieltippForms[123].gastTipp': '1', submitbutton: 'save' });
  });
  it('does not replay 307 POST redirects', async () => {
    const { page, fetch } = fake(html(), 307);
    await expect(new KicktippSubmissionAdapter(scope, async () => page).submit(fixture, { home: 2, away: 1 }, context())).rejects.toThrow('replay');
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });
  it('rechecks deadline after asynchronous authentication', async () => {
    const { page, fetch } = fake(); const ctx = context(); let now = kickoff - 60_000; ctx.now = () => now;
    const adapter = new KicktippSubmissionAdapter(scope, async () => { now = kickoff; return page; });
    await expect(adapter.submit(fixture, { home: 2, away: 1 }, ctx)).rejects.toThrow('window');
    expect(fetch.mock.calls.every(([, init]) => init.method !== 'POST')).toBe(true);
  });
  it('rechecks the deadline at the actual POST boundary', async () => {
    const { page, fetch } = fake(); const ctx = context(); let now = kickoff - 60_000; ctx.now = () => now;
    const original = page.submitSelectedForm.bind(page);
    page.submitSelectedForm = async (...args) => { now = kickoff; return original(...args); };
    await expect(new KicktippSubmissionAdapter(scope, async () => page).submit(fixture, { home: 2, away: 1 }, ctx)).rejects.toThrow('window');
    expect(fetch.mock.calls.every(([, init]) => init.method !== 'POST')).toBe(true);
  });
  it.each(['https://www.kicktipp.de/evil/predict', '/test/predict?bonus=true'])('rejects unexpected form action %s', async action => {
    const { page, fetch } = fake(html().replace('<form method="post">', `<form method="post" action="${action}">`));
    await expect(new KicktippSubmissionAdapter(scope, async () => page).submit(fixture, { home: 2, away: 1 }, context())).rejects.toThrow();
    expect(fetch.mock.calls.every(([, init]) => init.method !== 'POST')).toBe(true);
  });
  it('honors cancellation and read-only mode', async () => {
    const factory = vi.fn(async () => fake().page); const adapter = new KicktippSubmissionAdapter(scope, factory);
    const signal = AbortSignal.abort();
    await expect(adapter.submit(fixture, { home: 2, away: 1 }, { ...context(), signal })).rejects.toThrow();
    vi.stubEnv('KICKTIPP_READ_ONLY', '1');
    await expect(adapter.submit(fixture, { home: 2, away: 1 }, context())).rejects.toThrow('read-only');
    expect(factory).not.toHaveBeenCalled();
  });
  it('refuses changed fixture identity without sending', async () => {
    const { page, fetch } = fake(html(row('123', 'Different')));
    await expect(new KicktippSubmissionAdapter(scope, async () => page).submit(fixture, { home: 2, away: 1 }, context())).rejects.toThrow('identity');
    expect(fetch.mock.calls.every(([, init]) => init.method !== 'POST')).toBe(true);
  });
  it('reads a closed row against independently fetched schedule identity', async () => {
    const closed = '<tr><td>11.09.26 20:30</td><td>Union</td><td>Schalke</td><td class="nichttippbar">2:1</td></tr>';
    const adapter = new KicktippSubmissionAdapter(scope, async () => fake(html(closed)).page);
    expect(await adapter.read(fixture, context().signal)).toEqual({ fixture, score: { home: 2, away: 1 } });
    await expect(adapter.submit(fixture, { home: 2, away: 1 }, context())).rejects.toThrow('editable');
  });
  it('rejects form identity inconsistent with the canonical schedule', async () => {
    const adapter = new KicktippSubmissionAdapter(scope, async () => fake(html(row('999'))).page);
    await expect(adapter.read(fixture, context().signal)).rejects.toThrow('identity');
  });
  it('reads fresh score with full identity and returns null for absent score', async () => {
    const factory = vi.fn(async () => fake(html(row('123', 'Union', ['2', '1']))).page);
    const adapter = new KicktippSubmissionAdapter(scope, factory);
    expect(await adapter.read(fixture, context().signal)).toEqual({ fixture, score: { home: 2, away: 1 } });
    await adapter.read(fixture, context().signal); expect(factory).toHaveBeenCalledTimes(2);
    expect(await new KicktippSubmissionAdapter(scope, async () => fake().page).read(fixture, context().signal)).toBeNull();
  });
});


it('rejects off-host redirects even when the community path and HTML match', async () => {
  const page = new Page(undefined, async url => new URL(url).hostname === 'foreign.example'
    ? new Response(schedule())
    : new Response('', { status: 302, headers: { location: 'https://foreign.example/test/tippspielplan' } }));
  await expect(fetchWorkflowFixtures(page, scope, 3)).rejects.toThrow('origin');
});

it('rejects a truncated fixture row instead of silently dropping the match', async () => {
  const malformed = schedule(scheduleRow().replace('<td>-:-</td>', ''));
  await expect(fetchWorkflowFixtures(fake(html(), 200, malformed).page, scope, 3)).rejects.toThrow('Malformed');
});

it('detects current matchday from the public page when no matchday is specified', async () => {
  expect((await fetchWorkflowFixtures(fake().page, scope))[0]).toEqual(fixture);
});

it('allows explicit early test submission, but never overwrites an existing tip', async () => {
  const ctx = { ...context(), now: () => kickoff - 4 * 86400_000, allowEarlySubmission: true };
  const clean = fake();
  await new KicktippSubmissionAdapter(scope, async () => clean.page).submit(fixture, { home: 2, away: 1 }, ctx);
  expect(clean.fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  const occupied = fake(html(row('123', 'Union', ['1', '0'])));
  await expect(new KicktippSubmissionAdapter(scope, async () => occupied.page).submit(fixture, { home: 2, away: 1 }, ctx)).rejects.toThrow('overwrite');
  expect(occupied.fetch.mock.calls.every(([, init]) => init.method !== 'POST')).toBe(true);
});
it('keeps the final POST kickoff check in early test mode', async () => {
  const { page, fetch } = fake();
  let now = kickoff - 4 * 86400_000;
  const original = page.submitSelectedForm.bind(page);
  page.submitSelectedForm = async (...args) => { now = kickoff; return original(...args); };
  await expect(new KicktippSubmissionAdapter(scope, async () => page).submit(fixture, { home: 2, away: 1 }, {
    ...context(), now: () => now, allowEarlySubmission: true,
  })).rejects.toThrow('window');
  expect(fetch.mock.calls.every(([, init]) => init.method !== 'POST')).toBe(true);
});
