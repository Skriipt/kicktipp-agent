import { afterEach, describe, expect, it } from 'vitest';
import { fetchBonusReminders } from '../src/bonus-reminders.js';
import { Page } from '../src/http/page.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { setUrlBase } from '../src/url.js';
import { mockFetch, page as htmlPage } from './helpers/mock-fetch.js';

const BASE = 'https://www.kicktipp.de';
const question = 'Wer wird Meister?';
const slot = (id: string, selected = '-1', attributes = '') => `<select name="answers[${id}].tipp" ${attributes}>
  <option value="-1"${selected === '-1' ? ' selected' : ''}>---</option>
  <option value="81"${selected === '81' ? ' selected' : ''}>Team A</option>
</select>`;
const row = (title: string, controls: string) => `<tr><td>1</td><td>${title}</td><td>${controls}</td></tr>`;
const form = (...rows: string[]) => `<div id="kicktipp-content"><table id="tippabgabeFragen"><tbody>${rows.join('')}</tbody></table></div>`;

// Sanitized structure observed without authentication at
// https://www.kicktipp.de/projekte/tippspielplan?bonus=true on 2026-10-28.
// Event date and prediction deadline are intentionally different.
const schedule = (...rows: string[]) => `<div id="kicktipp-content"><table id="fragen"><thead><tr>
  <th name="wettbewerb">Wettbewerb</th><th name="termin">Termin</th>
  <th name="tipptermin">Tipptermin</th><th name="frage">Frage</th><th name="ergebnis">Ergebnis</th>
</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
const scheduled = (id: string, title = question, deadline = '02.02.27 18:00') => `<tr data-url="/pool/tippspielplan/frage?tippsaisonId=123&amp;tippfrageId=${id}">
  <td>1.BL</td><td>28.08.26 20:30</td><td>${deadline}</td><td>${title}</td><td>---</td></tr>`;

function source(predictions: string, fixtures: string = schedule(scheduled('1'))) {
  setUrlBase(BASE);
  const transport = mockFetch(req => {
    if (req.url === `${BASE}/pool/tippabgabe?bonus=true`) return htmlPage(predictions);
    if (req.url === `${BASE}/pool/tippspielplan?bonus=true`) return htmlPage(fixtures);
  });
  return { page: new Page(new CookieJar(), transport.fetchImpl), calls: transport.calls };
}

afterEach(() => { setUrlBase('https://www.kicktipp.com'); });

describe('bonus reminders', () => {
  it('counts each unanswered slot and uses the explicit prediction deadline', async () => {
    const { page, calls } = source(form(row(question, slot('a', '81') + slot('b') + slot('c'))));
    const reports = await fetchBonusReminders(page, 'pool');
    expect(reports).toEqual([{
      id: expect.any(String), question, missingAnswers: 2, editable: true,
      deadline: '2027-02-02T17:00:00.000Z',
    }]);
    expect(calls.map(call => call.method)).toEqual(['GET', 'GET']);
  });

  it('reports all missing slots and counts native default option selections', async () => {
    const controls = slot('a') + slot('b') +
      '<select name="answers[c].tipp"><option value="81">Team A</option></select>' +
      '<select name="answers[d].tipp"><option value="">---</option><option value="81">Team A</option></select>';
    const { page } = source(form(row(question, controls)));
    expect(await fetchBonusReminders(page, 'pool')).toEqual([
      expect.objectContaining({ missingAnswers: 3, editable: true }),
    ]);
  });

  it('does not fetch deadlines for fully answered, disabled or closed questions', async () => {
    const { page, calls } = source(form(
      row(question, slot('a', '81')),
      row('Disabled', slot('b', '-1', 'disabled')),
      row('Fieldset disabled', `<fieldset disabled>${slot('c')}</fieldset>`),
      row('Closed', 'Team A'),
    ));
    expect(await fetchBonusReminders(page, 'pool')).toEqual([
      expect.objectContaining({ question, editable: true, missingAnswers: 0 }),
      expect.objectContaining({ question: 'Disabled', editable: false, missingAnswers: 0 }),
      expect.objectContaining({ question: 'Fieldset disabled', editable: false, missingAnswers: 0 }),
      expect.objectContaining({ question: 'Closed', editable: false, missingAnswers: 0 }),
    ]);
    expect(calls).toHaveLength(1);
  });

  it('does not count disabled placeholders as answers or disabled controls as missing', async () => {
    const controls = slot('a', '-1', 'disabled') +
      '<select name="answers[b].tipp"><option value="81" disabled selected>Unavailable</option></select>';
    const { page } = source(form(row(question, controls)));
    expect(await fetchBonusReminders(page, 'pool')).toEqual([
      expect.objectContaining({ editable: true, missingAnswers: 1 }),
    ]);
  });

  it('leaves deadlines unknown when the schedule repeats a question across competitions', async () => {
    const { page } = source(form(row(question, slot('a'))),
      schedule(scheduled('1'), scheduled('2', question, '03.02.27 18:00')));
    expect(await fetchBonusReminders(page, 'pool')).toEqual([
      expect.objectContaining({ deadline: null, missingAnswers: 1 }),
    ]);
  });

  it('includes answered duplicate form questions in ambiguity detection', async () => {
    const { page } = source(form(row(question, slot('a')), row(question, slot('b', '81'))));
    const reports = await fetchBonusReminders(page, 'pool');
    expect(reports.map(report => report.deadline)).toEqual([null, null]);
    expect(reports[0].id).not.toBe(reports[1].id);
  });

  it.each(['', 'Termin folgt', '31.02.27 18:00', '28.03.27 02:30'])(
    'leaves missing or invalid deadline %j unknown instead of using the event date', async deadline => {
      const { page } = source(form(row(question, slot('a'))), schedule(scheduled('1', question, deadline)));
      expect((await fetchBonusReminders(page, 'pool'))[0].deadline).toBeNull();
    },
  );

  it('uses named headers even when the deadline column moves', async () => {
    const { page } = source(form(row(question, slot('a'))), `<div id="kicktipp-content"><table id="fragen">
      <thead><tr><th name="frage">Frage</th><th name="termin">Termin</th><th name="tipptermin">Tipptermin</th></tr></thead>
      <tbody><tr><td>${question}</td><td>01.01.27 12:00</td><td>02.02.27 18:00</td></tr></tbody>
    </table></div>`);
    expect((await fetchBonusReminders(page, 'pool'))[0].deadline).toBe('2027-02-02T17:00:00.000Z');
  });

  it('does not guess a deadline when its named header is missing', async () => {
    const { page } = source(form(row(question, slot('a'))),
      schedule(scheduled('1')).replace('name="tipptermin"', 'name="unknown"'));
    expect((await fetchBonusReminders(page, 'pool'))[0].deadline).toBeNull();
  });

  it('reads English printed deadlines in their server timezone', async () => {
    const { page } = source(form(row(question, slot('a'))), schedule(scheduled('1', question, '2/2/27 11:00 AM')));
    expect((await fetchBonusReminders(page, 'pool'))[0].deadline).toBe('2027-02-02T17:00:00.000Z');
  });

  it('keeps identities stable when form rows are reordered', async () => {
    const first = source(form(row(question, slot('a')), row('Second', slot('b'))), schedule());
    const second = source(form(row('Second', slot('b')), row(question, slot('a'))), schedule());
    const a = await fetchBonusReminders(first.page, 'pool');
    const b = await fetchBonusReminders(second.page, 'pool');
    expect(a[0].id).toBe(b[1].id);
    expect(a[1].id).toBe(b[0].id);
    expect(a[0].id).not.toBe(a[1].id);
  });

  it('scopes a uniquely matched schedule identity to its season and question', async () => {
    const { page } = source(form(row(question, slot('form-index-unrelated-to-id'))));
    expect((await fetchBonusReminders(page, 'pool'))[0].id).toBe('bonus:123:1');
  });

  it('returns no bonus questions without requesting the schedule when the form has none', async () => {
    const { page, calls } = source('<div id="kicktipp-content">Keine Bonusfragen</div>');
    expect(await fetchBonusReminders(page, 'pool')).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('propagates an unauthenticated schedule response instead of treating it as no questions', async () => {
    const { page } = source(form(row(question, slot('a'))), '<input type="password" name="password">');
    await expect(fetchBonusReminders(page, 'pool')).rejects.toThrow(/not authenticated/);
  });
});
