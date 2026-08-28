import { describe, it, expect, afterEach, vi } from 'vitest';
import { Page } from '../src/http/page.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { placeBets, placeBonusBets } from '../src/core.js';
import { isReadOnly, assertWritable, ReadOnlyError } from '../src/read-only.js';
import { mockFetch, page as htmlPage } from './helpers/mock-fetch.js';

afterEach(() => vi.unstubAllEnvs());

describe('isReadOnly', () => {
  it('is off by default', () => {
    expect(isReadOnly()).toBe(false);
  });

  it('is on for the usual truthy spellings', () => {
    for (const value of ['1', 'true', 'yes', 'on']) {
      vi.stubEnv('KICKTIPP_READ_ONLY', value);
      expect(isReadOnly()).toBe(true);
    }
  });

  it('is off for explicit falsey spellings', () => {
    for (const value of ['', '0', 'false', 'FALSE']) {
      vi.stubEnv('KICKTIPP_READ_ONLY', value);
      expect(isReadOnly()).toBe(false);
    }
  });
});

describe('assertWritable', () => {
  it('passes when writes are allowed', () => {
    expect(() => assertWritable()).not.toThrow();
  });

  it('names the action and how to turn it off', () => {
    vi.stubEnv('KICKTIPP_READ_ONLY', '1');
    expect(() => assertWritable('Placing bets')).toThrow(ReadOnlyError);
    expect(() => assertWritable('Placing bets')).toThrow(/Placing bets is blocked/);
    expect(() => assertWritable()).toThrow(/KICKTIPP_READ_ONLY/);
  });
});

describe('the core submitting functions refuse regardless of entry point', () => {
  const FORM = `<div id="kicktipp-content"><form method="post" action="/c/tippabgabe">
      <table id="tippabgabeSpiele"><tbody><tr>
        <td>21.08.26</td><td>Bayern</td><td>BVB</td>
        <td><input id="r1_heimTipp" name="r1_heimTipp" value=""><input id="r1_gastTipp" name="r1_gastTipp" value=""></td>
        <td></td></tr></tbody></table>
      <button type="submit" name="submitbutton" value="save">save</button></form></div>`;

  function betPage() {
    const { fetchImpl, calls } = mockFetch(() => htmlPage(FORM));
    return { page: new Page(new CookieJar(), fetchImpl), calls };
  }

  it('blocks placeBets before anything is submitted', async () => {
    vi.stubEnv('KICKTIPP_READ_ONLY', '1');
    const { page, calls } = betPage();
    await expect(placeBets(page, 'c', ['Bayern vs BVB=2:1'])).rejects.toBeInstanceOf(ReadOnlyError);
    // Refused up front: not a single request was made.
    expect(calls).toHaveLength(0);
  });

  it('blocks placeBonusBets too', async () => {
    vi.stubEnv('KICKTIPP_READ_ONLY', '1');
    const { page } = betPage();
    await expect(placeBonusBets(page, 'c', ['Q=A'])).rejects.toBeInstanceOf(ReadOnlyError);
  });

  it('still allows a dry run, which submits nothing by definition', async () => {
    vi.stubEnv('KICKTIPP_READ_ONLY', '1');
    const { page } = betPage();
    const placed = await placeBets(page, 'c', ['Bayern vs BVB=2:1'], undefined, false);
    expect(placed).toEqual([{ home: 'Bayern', away: 'BVB', homeGoals: 2, awayGoals: 1 }]);
  });

  it('submits normally when the mode is off', async () => {
    const { page, calls } = betPage();
    await placeBets(page, 'c', ['Bayern vs BVB=2:1']);
    expect(calls.some((c) => c.method === 'POST')).toBe(true);
  });
});
