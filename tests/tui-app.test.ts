import { describe, it, expect, beforeAll } from 'vitest';
import { setColorMode } from '../src/tui/app/ansi.js';
import { fit, truncate, visibleWidth, wrap, stripAnsi } from '../src/tui/app/text.js';
import { renderTable } from '../src/tui/app/table.js';
import { decodeKey } from '../src/tui/app/keys.js';
import { flatItems, findItem, MENU } from '../src/tui/app/menu.js';
import { buildDemoWorld, DEMO_CURRENT_MATCHDAY, DEMO_PLAYER } from '../src/tui/app/demo-data.js';
import { DemoDataSource } from '../src/tui/app/demo-source.js';
import * as F from '../src/tui/app/format.js';
import { App } from '../src/tui/app/app.js';

// Colour off keeps every assertion about the visible text, not escape codes.
beforeAll(() => setColorMode({ color: false }));

describe('text geometry', () => {
  it('measures visible width ignoring ANSI', () => {
    expect(visibleWidth('\x1b[1mhi\x1b[0m')).toBe(2);
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('fits to an exact width with alignment', () => {
    expect(fit('ab', 5)).toBe('ab   ');
    expect(fit('ab', 5, 'right')).toBe('   ab');
    expect(fit('ab', 5, 'center')).toBe(' ab  ');
    expect(visibleWidth(fit('a very long string indeed', 8))).toBe(8);
  });

  it('truncates with an ellipsis', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });

  it('wraps on word boundaries', () => {
    expect(wrap('one two three', 7)).toEqual(['one two', 'three']);
    expect(wrap('supercalifragilistic', 5).every((l) => visibleWidth(l) <= 5)).toBe(true);
  });
});

describe('table', () => {
  it('keeps every rendered line within the width', () => {
    const lines = renderTable({
      width: 30,
      columns: [{ header: 'Match', flex: true }, { header: 'Bet', align: 'right' }],
      rows: [
        ['FC Bayern München vs Borussia Dortmund', '2:1'],
        ['RB Leipzig vs SC Freiburg', '1:1'],
      ],
    });
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    expect(lines.length).toBe(3); // header + 2 rows
  });

  it('shows a placeholder when empty', () => {
    const lines = renderTable({ width: 20, columns: [{ header: 'X' }], rows: [] });
    expect(lines.join('\n')).toMatch(/nothing to show/);
  });
});

describe('key decoding', () => {
  it('decodes the navigation vocabulary', () => {
    expect(decodeKey('\x1b[A')).toEqual({ type: 'up' });
    expect(decodeKey('\x1b[B')).toEqual({ type: 'down' });
    expect(decodeKey('\x1b[C')).toEqual({ type: 'right' });
    expect(decodeKey('\x1b[D')).toEqual({ type: 'left' });
    expect(decodeKey('\r')).toEqual({ type: 'enter' });
    expect(decodeKey('\t')).toEqual({ type: 'tab' });
    expect(decodeKey('\x1b')).toEqual({ type: 'escape' });
    expect(decodeKey('\x03')).toEqual({ type: 'quit' });
    expect(decodeKey('k')).toEqual({ type: 'char', value: 'k' });
    expect(decodeKey('\x1b[Z')).toEqual({ type: 'shift-tab' });
  });
});

describe('menu', () => {
  it('exposes every feature as a navigable item', () => {
    const ids = flatItems().map((i) => i.id);
    for (const id of ['today', 'bets', 'place', 'suggest', 'leaderboard', 'overview', 'table', 'schedule', 'stats', 'rival', 'scenario', 'whatif', 'deadline', 'sync', 'cache', 'rules', 'log', 'guide', 'communities', 'players', 'setcommunity', 'setplayer', 'profiles', 'notify', 'account', 'members', 'memberbets', 'bonus']) {
      expect(ids).toContain(id);
    }
    expect(findItem('today')?.label).toBe('Today');
    expect(MENU.length).toBeGreaterThan(4);
  });
});

describe('demo world', () => {
  const world = buildDemoWorld();

  it('builds a full season with cumulative leaderboards', () => {
    expect(world.season.matchdays).toHaveLength(DEMO_CURRENT_MATCHDAY);
    const last = world.season.matchdays[DEMO_CURRENT_MATCHDAY - 2].leaderboard!;
    expect(last.rankings).toHaveLength(world.players.length);
    // Totals are non-increasing down the ranked table.
    const totals = last.rankings.map((r) => Number(r.total));
    for (let i = 1; i < totals.length; i++) expect(totals[i - 1]).toBeGreaterThanOrEqual(totals[i]);
  });

  it('has an 18-team league table that sums to the played games', () => {
    expect(world.table.teams).toHaveLength(18);
    const played = world.table.teams.reduce((s, t) => s + Number(t.played), 0);
    // Each finished match adds one game to two teams.
    expect(played % 2).toBe(0);
  });

  it('marks the current player on the leaderboard', () => {
    const md = world.season.matchdays[10].leaderboard!;
    expect(md.rankings.some((r) => r.isCurrentPlayer && r.name === DEMO_PLAYER)).toBe(true);
  });
});

describe('demo source drives the real analytics', () => {
  const source = new DemoDataSource();

  it('produces season stats without throwing', async () => {
    const stats = await source.stats();
    expect(stats.form.length).toBeGreaterThan(0);
    expect(stats.breakdown.scored).toBeGreaterThan(0);
  });

  it('replays a season under another strategy', async () => {
    const replay = await source.replay('home');
    expect(replay.matchdays.length).toBeGreaterThan(0);
    expect(Number.isFinite(replay.total)).toBe(true);
  });

  it('suggests a full slip', async () => {
    const out = await source.suggest('ev');
    expect(out.suggestions.length).toBe(9);
    expect(out.suggestions.every((b) => /^\d+:\d+$/.test(b.bet))).toBe(true);
  });

  it('analyses a rival and projects a scenario', async () => {
    const rival = await source.rival('Lena Fischer');
    expect(rival.perMatch.length).toBe(9);
    const scenario = await source.scenario();
    expect(scenario.players.length).toBe(source['world'].players.length);
  });

  it('places bets into the in-memory world', async () => {
    const before = await source.bets();
    const placed = await source.placeBets([`${before.matches[0].home} vs ${before.matches[0].away}=3:0`]);
    expect(placed[0]).toMatchObject({ homeGoals: 3, awayGoals: 0 });
    const after = await source.bets();
    expect(after.matches[0].bet).toBe('3:0');
  });
});

describe('formatters render within their width', () => {
  const source = new DemoDataSource();
  const width = 76;
  const check = (lines: string[]) => {
    for (const line of lines) expect(visibleWidth(line), JSON.stringify(stripAnsi(line))).toBeLessThanOrEqual(width);
  };

  it('renders every read view', async () => {
    check(F.todayView(await source.today(), width));
    check(F.betsView(await source.bets(), width));
    check(F.scheduleView(await source.schedule(), width));
    check(F.leaderboardView(await source.leaderboard(), width));
    check(F.overviewView(await source.overview(), width));
    check(F.tableView(await source.table(), width));
    check(F.rulesView(await source.rules(), width));
    check(F.deadlineView(await source.deadline(), width));
    check(F.suggestView(await source.suggest('safe'), width));
    check(F.statsView(await source.stats(), width));
    check(F.rivalView(await source.rival('Max Weber'), width));
    check(F.scenarioView(await source.scenario(), width));
    check(F.replayView(await source.replay('favorite'), width));
    check(F.auditView(source.auditLog(), width));
    check(F.bonusView(await source.bonusBets(), width));
    check(F.membersView(await source.members(), width));
  });
});

describe('app composes a full frame headlessly', () => {
  it('renders the dashboard to a fixed viewport', async () => {
    const app = new App(new DemoDataSource());
    app.setViewport(30, 100);
    const frame = await app.snapshot('leaderboard');
    expect(frame.length).toBe(30);
    for (const line of frame) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
    const text = frame.map(stripAnsi).join('\n');
    expect(text).toContain('kicktipp');
    expect(text).toContain('Leaderboard');
    expect(text).toContain('Menu');
  });

  it('renders the interactive place-bets grid', async () => {
    const app = new App(new DemoDataSource());
    app.setViewport(30, 100);
    const frame = await app.snapshot('place');
    const text = frame.map(stripAnsi).join('\n');
    expect(text).toContain('Place bets');
    expect(text).toMatch(/_:_|closed|\d:\d/);
  });
});
