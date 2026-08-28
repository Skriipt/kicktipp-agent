import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Page } from '../src/http/page.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { fetchBonusQuestions, placeBonusBets } from '../src/core.js';
import { mockFetch, page as htmlPage, type RecordedRequest } from './helpers/mock-fetch.js';

const BASE = 'https://www.kicktipp.com';
const BONUS_URL = `${BASE}/cape/predict?bonus=true`;

const TEAMS = [
  ['81', 'FC Bayern München'],
  ['7', 'Borussia Dortmund'],
  ['16', 'FC St. Pauli'],
  ['18', '1. FC Heidenheim'],
  ['15', 'Holstein Kiel'],
] as const;

function options(selected = '-1'): string {
  return [
    `<option value="-1"${selected === '-1' ? ' selected' : ''}>---</option>`,
    ...TEAMS.map(
      ([value, text]) =>
        `<option value="${value}"${selected === value ? ' selected' : ''}>${text}</option>`,
    ),
  ].join('');
}

function select(name: string, selected = '-1'): string {
  return `<select name="${name}">${options(selected)}</select>`;
}

/**
 * Kicktipp-shaped bonus form: one single-dropdown question plus a
 * three-dropdown ranking (relegation). Names use the same bracketed
 * `foo[id].tipp` pattern as match bets.
 */
function bonusForm(): string {
  return `<div id="kicktipp-content"><form method="post" action="/cape/predict">
    <input type="hidden" name="bonus" value="true">
    <table id="tippabgabeFragen"><tbody>
      <tr>
        <td>1</td>
        <td>Who will be champion?</td>
        <td>${select('tippabgabeFragenForms[111].tipp')}</td>
      </tr>
      <tr>
        <td>2</td>
        <td>Who will be relegated?</td>
        <td>
          ${select('tippabgabeFragenForms[222].tipp')}
          ${select('tippabgabeFragenForms[223].tipp')}
          ${select('tippabgabeFragenForms[224].tipp')}
        </td>
      </tr>
    </tbody></table>
    <button type="submit" name="submitbutton" value="save">save</button>
  </form></div>`;
}

function bonusPage() {
  const { fetchImpl, calls } = mockFetch((req) =>
    req.method === 'GET' && req.url.startsWith(BONUS_URL)
      ? htmlPage(bonusForm())
      : htmlPage('saved'),
  );
  return { page: new Page(new CookieJar(), fetchImpl), calls };
}

function fields(req: RecordedRequest | undefined): URLSearchParams {
  return new URLSearchParams(req?.body || '');
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kicktipp-bonus-'));
  vi.stubEnv('KICKTIPP_DATA_DIR', tmp);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('fetchBonusQuestions', () => {
  it('reads every dropdown on a ranking question', async () => {
    const { page } = bonusPage();
    const questions = await fetchBonusQuestions(page, 'cape');
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({
      question: 'Who will be champion?',
      selects: [{ name: 'tippabgabeFragenForms[111].tipp' }],
    });
    expect(questions[1].question).toBe('Who will be relegated?');
    expect(questions[1].selects.map((s) => s.name)).toEqual([
      'tippabgabeFragenForms[222].tipp',
      'tippabgabeFragenForms[223].tipp',
      'tippabgabeFragenForms[224].tipp',
    ]);
  });
});

describe('placeBonusBets', () => {
  it('fills all three relegation dropdowns in one call', async () => {
    const { page, calls } = bonusPage();
    const placed = await placeBonusBets(
      page,
      'cape',
      [
        'Who will be relegated?=FC St. Pauli',
        'Who will be relegated?=1. FC Heidenheim',
        'Who will be relegated?=Holstein Kiel',
      ],
      true,
      'mcp:place_bonus_bets',
    );

    expect(placed).toEqual([
      { question: 'Who will be relegated?', answer: 'FC St. Pauli' },
      { question: 'Who will be relegated?', answer: '1. FC Heidenheim' },
      { question: 'Who will be relegated?', answer: 'Holstein Kiel' },
    ]);

    const post = calls.find((c) => c.method === 'POST');
    const body = fields(post);
    expect(body.get('tippabgabeFragenForms[222].tipp')).toBe('16');
    expect(body.get('tippabgabeFragenForms[223].tipp')).toBe('18');
    expect(body.get('tippabgabeFragenForms[224].tipp')).toBe('15');
  });

  it('places every question when they are submitted together', async () => {
    const { page, calls } = bonusPage();
    const placed = await placeBonusBets(
      page,
      'cape',
      [
        'Who will be champion?=FC Bayern München',
        'Who will be relegated?=FC St. Pauli',
        'Who will be relegated?=1. FC Heidenheim',
        'Who will be relegated?=Holstein Kiel',
      ],
      true,
      'mcp:place_bonus_bets',
    );

    expect(placed).toEqual([
      { question: 'Who will be champion?', answer: 'FC Bayern München' },
      { question: 'Who will be relegated?', answer: 'FC St. Pauli' },
      { question: 'Who will be relegated?', answer: '1. FC Heidenheim' },
      { question: 'Who will be relegated?', answer: 'Holstein Kiel' },
    ]);

    const body = fields(calls.find((c) => c.method === 'POST'));
    expect(body.get('tippabgabeFragenForms[111].tipp')).toBe('81');
    expect(body.get('tippabgabeFragenForms[222].tipp')).toBe('16');
    expect(body.get('tippabgabeFragenForms[223].tipp')).toBe('18');
    expect(body.get('tippabgabeFragenForms[224].tipp')).toBe('15');
  });

  it('names the question, not the answer, when nothing matches', async () => {
    const { page } = bonusPage();
    await expect(
      placeBonusBets(page, 'cape', ['Not a real question?=FC Bayern München'], false),
    ).rejects.toThrow(/No bonus question found matching: "Not a real question\?"/);
  });

  it('fills the next empty ranking slot instead of overwriting the first', async () => {
    const { fetchImpl, calls } = mockFetch((req) =>
      req.method === 'GET' && req.url.startsWith(BONUS_URL)
        ? htmlPage(`<div id="kicktipp-content"><form method="post" action="/cape/predict">
            <table id="tippabgabeFragen"><tbody>
              <tr>
                <td>2</td>
                <td>Who will be relegated?</td>
                <td>
                  ${select('tippabgabeFragenForms[222].tipp', '16')}
                  ${select('tippabgabeFragenForms[223].tipp')}
                  ${select('tippabgabeFragenForms[224].tipp')}
                </td>
              </tr>
            </tbody></table>
            <button type="submit" name="submitbutton" value="save">save</button>
          </form></div>`)
        : htmlPage('saved'),
    );
    const page = new Page(new CookieJar(), fetchImpl);
    await placeBonusBets(page, 'cape', ['Who will be relegated?=1. FC Heidenheim'], true);

    const body = fields(calls.find((c) => c.method === 'POST'));
    expect(body.get('tippabgabeFragenForms[222].tipp')).toBe('16');
    expect(body.get('tippabgabeFragenForms[223].tipp')).toBe('18');
    expect(body.get('tippabgabeFragenForms[224].tipp')).toBe('-1');
  });

  it('rejects a duplicate team on a ranking question', async () => {
    const { page } = bonusPage();
    await expect(
      placeBonusBets(page, 'cape', [
        'Who will be relegated?=FC St. Pauli',
        'Who will be relegated?=FC St. Pauli',
      ]),
    ).rejects.toThrow(/Duplicate answer "FC St. Pauli"/);
  });

  it('does not look up the question by the answer text', async () => {
    const { page, calls } = bonusPage();
    await expect(
      placeBonusBets(page, 'cape', ['Who will be champion?=FC Bayern München'], false),
    ).resolves.toEqual([{ question: 'Who will be champion?', answer: 'FC Bayern München' }]);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('selectOption with Kicktipp-style names', () => {
  it('updates each bracketed name, not only the first select', async () => {
    const { fetchImpl, calls } = mockFetch((req) =>
      req.method === 'GET'
        ? htmlPage(`<form method="post" action="/c/form">
            ${select('tippabgabeFragenForms[222].tipp')}
            ${select('tippabgabeFragenForms[223].tipp')}
            ${select('tippabgabeFragenForms[224].tipp')}
            <button type="submit" name="submitbutton" value="save">save</button>
          </form>`)
        : htmlPage('saved'),
    );
    const page = new Page(new CookieJar(), fetchImpl);
    await page.goto(`${BASE}/c/form`);
    await page.selectOption('select[name="tippabgabeFragenForms[222].tipp"]', '16');
    await page.selectOption('select[name="tippabgabeFragenForms[223].tipp"]', '18');
    await page.selectOption('select[name="tippabgabeFragenForms[224].tipp"]', '15');
    await page.click('button[name="submitbutton"]');

    const body = fields(calls[calls.length - 1]);
    expect(body.get('tippabgabeFragenForms[222].tipp')).toBe('16');
    expect(body.get('tippabgabeFragenForms[223].tipp')).toBe('18');
    expect(body.get('tippabgabeFragenForms[224].tipp')).toBe('15');
  });
});
