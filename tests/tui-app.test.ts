import { beforeAll, describe, expect, it } from 'vitest';
import { App } from '../src/tui/app/app.js';
import { setColorMode } from '../src/tui/app/ansi.js';
import { decodeKey } from '../src/tui/app/keys.js';
import { flatItems, findItem, MENU } from '../src/tui/app/menu.js';
import { renderTable } from '../src/tui/app/table.js';
import { fit, stripAnsi, truncate, visibleWidth, wrap } from '../src/tui/app/text.js';
import type { LiveDataSource } from '../src/tui/app/live-source.js';

beforeAll(() => setColorMode({ color: false }));

function source(): LiveDataSource {
  return {
    getContext: () => ({
      community: 'test',
      player: 'Tester',
      profile: null,
      readOnly: false,
      loggedIn: true,
    }),
    today: async () => ({ title: 'Today', matches: [] }),
  } as unknown as LiveDataSource;
}

describe('text geometry', () => {
  it('measures and fits visible text', () => {
    expect(visibleWidth('\x1b[1mhi\x1b[0m')).toBe(2);
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(fit('ab', 5)).toBe('ab   ');
    expect(visibleWidth(fit('a very long string', 8))).toBe(8);
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(wrap('one two three', 7)).toEqual(['one two', 'three']);
  });
});

describe('table', () => {
  it('keeps every rendered line within the width', () => {
    const lines = renderTable({
      width: 30,
      columns: [{ header: 'Match', flex: true }, { header: 'Bet', align: 'right' }],
      rows: [['FC Bayern München vs Borussia Dortmund', '2:1']],
    });
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
  });
});

describe('navigation', () => {
  it('decodes keys and exposes the dashboard', () => {
    expect(decodeKey('\x1b[A')).toEqual({ type: 'up' });
    expect(decodeKey('\r')).toEqual({ type: 'enter' });
    expect(decodeKey('\x03')).toEqual({ type: 'quit' });
    expect(findItem('today')?.label).toBe('Today');
    expect(flatItems().map((item) => item.id)).toContain('place');
    expect(MENU.length).toBeGreaterThan(4);
  });

  it('renders a full frame without a network connection', async () => {
    const app = new App(source());
    app.setViewport(24, 80);
    const frame = await app.snapshot('today');
    expect(frame).toHaveLength(24);
    for (const line of frame) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    expect(frame.map(stripAnsi).join('\n')).toContain('Today');
  });
});
