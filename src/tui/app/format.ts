/**
 * Pure formatters: data in, content lines out.
 *
 * Every read screen is built here, which keeps the app loop small and lets
 * the layouts be asserted on in tests (colour off, so the text is bare). A
 * formatter returns the inner lines of the content pane; the app frames them.
 */
import { bold, dim, fg, italic } from './ansi.js';
import { palette, glyph } from './theme.js';
import { fit, padLeft, truncate, visibleWidth, wrap } from './text.js';
import { bar, sparkline, badge, field } from './box.js';
import { renderTable } from './table.js';
import type {
  BetMatch,
  BonusAnswer,
  LeaderboardData,
  Member,
  OverviewData,
  RulesSection,
  ScheduleMatch,
  TableTeam,
  TodayMatch,
} from '../../core.js';
import type { DeadlineReport } from '../../analytics/deadline.js';
import type { SeasonStats } from '../../analytics/season-stats.js';
import type { ReplayResult } from '../../analytics/replay.js';
import type { RivalAnalysis } from '../../analytics/rivals.js';
import type { ScenarioProjection } from '../../analytics/scenarios.js';
import type { AuditRecord } from '../../audit/log.js';
import type { CacheInfo, SuggestOutcome } from './source.js';

const fixture = (home: string, away: string): string => `${home} ${dim('vs')} ${away}`;

/** A section heading with a leading accent tick. */
export function heading(text: string): string {
  return `${fg(palette.primary, glyph.barHalf)} ${bold(fg(palette.heading, text))}`;
}

function empty(message: string): string[] {
  return [dim(`  ${message}`)];
}

/** A wrapped, amber note line (or lines) — for warnings and caveats. */
function note(text: string, width: number): string[] {
  return wrap(text, width).map((l) => dim(fg(palette.amber, l)));
}

function betCell(bet: string): string {
  return /^\d+:\d+$/.test(bet) ? fg(palette.text, bet) : dim('—');
}

function resultCell(result: string): string {
  return /^\d+:\d+$/.test(result) ? bold(fg(palette.heading, result)) : dim(result);
}

// ── Today ─────────────────────────────────────────────────────────

export function todayView(
  data: { title: string; matches: TodayMatch[] },
  width: number,
): string[] {
  if (!data.matches.length) return empty('No matches scheduled for today.');
  const rows = data.matches.map((m) => [
    fg(palette.accent, m.time),
    fixture(m.home, m.away),
    m.needsBet ? badge('NEEDS BET', palette.bg, palette.amber) : fg(palette.primary, m.bet),
  ]);
  return renderTable({
    width,
    columns: [
      { header: 'Time' },
      { header: 'Match', flex: true, min: 16 },
      { header: 'Your bet', align: 'right' },
    ],
    rows,
  });
}

// ── Bets ──────────────────────────────────────────────────────────

export function betsView(data: { title: string; matches: BetMatch[] }, width: number): string[] {
  if (!data.matches.length) return empty('No matches on this matchday.');
  const rows = data.matches.map((m) => [
    dim(m.date),
    fixture(m.home, m.away),
    betCell(m.bet),
    dim(`${m.odds.home}/${m.odds.draw}/${m.odds.away}`),
  ]);
  return renderTable({
    width,
    zebra: true,
    columns: [
      { header: 'Kickoff' },
      { header: 'Match', flex: true, min: 16 },
      { header: 'Bet', align: 'center' },
      { header: 'Odds H/D/A', align: 'right' },
    ],
    rows,
  });
}

// ── Schedule ──────────────────────────────────────────────────────

export function scheduleView(
  data: { title: string; matches: ScheduleMatch[] },
  width: number,
): string[] {
  if (!data.matches.length) return empty('No fixtures found.');
  const rows = data.matches.map((m) => [dim(m.date), fixture(m.home, m.away), resultCell(m.result)]);
  return renderTable({
    width,
    zebra: true,
    columns: [
      { header: 'Kickoff' },
      { header: 'Match', flex: true, min: 16 },
      { header: 'Result', align: 'center' },
    ],
    rows,
  });
}

// ── Leaderboard ───────────────────────────────────────────────────

export function leaderboardView(data: LeaderboardData, width: number): string[] {
  const out: string[] = [];

  if (data.bonusQuestions?.length) {
    out.push(heading('Bonus questions'), '');
    out.push(
      ...renderTable({
        width,
        columns: [
          { header: 'Abbr' },
          { header: 'Question', flex: true, min: 16 },
          { header: 'Result', align: 'right' },
        ],
        rows: data.bonusQuestions.map((q) => [fg(palette.accent, q.abbreviation), q.question, q.result]),
      }),
      '',
    );
  }

  out.push(heading('Ranking'), '');
  const highlight = new Set<number>();
  const rows = data.rankings.map((r, i) => {
    if (r.isCurrentPlayer) highlight.add(i);
    const pos = rankBadge(r.position);
    return [pos, r.isCurrentPlayer ? bold(r.name) : r.name, dim(r.matchdayPoints), dim(r.bonus), bold(r.total)];
  });
  out.push(
    ...renderTable({
      width,
      highlightRows: highlight,
      columns: [
        { header: '#', align: 'right' },
        { header: 'Player', flex: true, min: 12 },
        { header: 'MD', align: 'right' },
        { header: 'Bonus', align: 'right' },
        { header: 'Total', align: 'right' },
      ],
      rows,
    }),
  );
  if (!data.rankings.length) out.push(...empty('No ranking published yet.'));
  return out;
}

function rankBadge(position: string): string {
  const n = Number(position);
  if (n === 1) return fg(palette.gold, `${glyph.star}${position}`);
  if (n === 2 || n === 3) return fg(palette.teal, position);
  return dim(position);
}

// ── Overview ──────────────────────────────────────────────────────

export function overviewView(data: OverviewData, width: number): string[] {
  const days = Array.from({ length: data.maxMatchday }, (_, i) => i + 1);
  const highlight = new Set<number>();
  const rows = data.players.map((p, i) => {
    if (p.isCurrentPlayer) highlight.add(i);
    const form = days.map((d) => (p.matchdays[d] !== undefined ? Number(p.matchdays[d]) : null));
    return [
      rankBadge(p.position),
      p.isCurrentPlayer ? bold(p.name) : p.name,
      sparkline(form, p.isCurrentPlayer ? palette.gold : palette.primary),
      dim(p.bonus),
      dim(p.wins),
      bold(p.total),
    ];
  });
  return renderTable({
    width,
    highlightRows: highlight,
    columns: [
      { header: '#', align: 'right' },
      { header: 'Player', flex: true, min: 12 },
      { header: `Form (MD 1–${data.maxMatchday})` },
      { header: 'Bonus', align: 'right' },
      { header: 'Wins', align: 'right' },
      { header: 'Total', align: 'right' },
    ],
    rows,
  });
}

// ── League table ──────────────────────────────────────────────────

export function tableView(data: { label: string; teams: TableTeam[] }, width: number): string[] {
  const rows = data.teams.map((t, i) => [
    zoneBadge(i + 1, t.position),
    t.team,
    dim(t.played),
    bold(t.points),
    dim(`${t.goalsFor}:${t.goalsAgainst}`),
    diffCell(t.goalDifference),
    dim(t.wins),
    dim(t.draws),
    dim(t.losses),
  ]);
  return renderTable({
    width,
    columns: [
      { header: '#', align: 'right' },
      { header: 'Team', flex: true, min: 12 },
      { header: 'P', align: 'right' },
      { header: 'Pts', align: 'right' },
      { header: 'Goals', align: 'right' },
      { header: 'GD', align: 'right' },
      { header: 'W', align: 'right' },
      { header: 'D', align: 'right' },
      { header: 'L', align: 'right' },
    ],
    rows,
  });
}

function zoneBadge(index: number, position: string): string {
  if (index <= 4) return fg(palette.primary, position); // Champions League
  if (index <= 6) return fg(palette.teal, position); // Europe
  if (index >= 16) return fg(palette.red, position); // relegation
  return dim(position);
}

function diffCell(gd: string): string {
  const n = Number(gd);
  if (n > 0) return fg(palette.primary, gd);
  if (n < 0) return fg(palette.red, gd);
  return dim(gd);
}

// ── Rules ─────────────────────────────────────────────────────────

export function rulesView(sections: RulesSection[], width: number): string[] {
  if (!sections.length) return empty('No rules published for this community.');
  const out: string[] = [];
  for (const section of sections) {
    if (section.type === 'heading') {
      if (out.length) out.push('');
      out.push(heading(section.text ?? ''));
    } else if (section.type === 'paragraph') {
      out.push(...wrap(section.text ?? '', width).map((l) => dim(l)));
    } else if (section.type === 'table' && section.headers) {
      out.push('');
      out.push(
        ...renderTable({
          width,
          columns: section.headers.map((h, i) => ({ header: h, flex: i === 0 })),
          rows: section.rows ?? [],
        }),
      );
    }
  }
  return out;
}

// ── Simple lists ──────────────────────────────────────────────────

export function bulletList(items: string[], marker = glyph.dot): string[] {
  if (!items.length) return empty('Nothing to show.');
  return items.map((item) => `  ${fg(palette.primary, marker)} ${item}`);
}

// ── Deadline ──────────────────────────────────────────────────────

export function deadlineView(report: DeadlineReport, width: number): string[] {
  const out: string[] = [];
  const next =
    report.nextKickoffIn !== null
      ? `${fg(palette.accent, glyph.clock)} Next kickoff ${bold(report.nextKickoffIn)}`
      : dim('No upcoming kickoff.');
  out.push(next);
  out.push(
    dim(
      `${report.openCount} open · ${report.needsBetCount} need a bet · ${report.urgentCount} urgent · times in ${report.timeZone}`,
    ),
    '',
  );

  const rows = report.matches.map((m) => {
    let state: string;
    if (m.closed) state = dim('closed');
    else if (m.urgent) state = badge('URGENT', palette.bg, palette.red);
    else if (m.needsBet) state = fg(palette.amber, 'no bet');
    else state = fg(palette.primary, `bet ${m.bet}`);
    const when = m.kickoff ? relativeFrom(report.now, m.kickoff) : dim('—');
    return [fixture(m.home, m.away), when, state];
  });
  out.push(
    ...renderTable({
      width,
      columns: [
        { header: 'Match', flex: true, min: 16 },
        { header: 'Kickoff' },
        { header: 'State', align: 'right' },
      ],
      rows,
    }),
  );
  return out;
}

function relativeFrom(nowIso: string, kickoffIso: string): string {
  const ms = new Date(kickoffIso).getTime() - new Date(nowIso).getTime();
  if (ms <= 0) return dim('started');
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `in ${mins}m`;
  if (mins < 60 * 24) return `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `in ${Math.floor(mins / (60 * 24))}d`;
}

// ── Suggestions ───────────────────────────────────────────────────

export function suggestView(outcome: SuggestOutcome, width: number): string[] {
  const out: string[] = [];
  out.push(
    `${dim('Strategy')} ${badge(outcome.strategy.toUpperCase(), palette.bg, palette.primary)}  ${dim(
      `rules ${outcome.rules.values.exact}/${outcome.rules.values.goalDiff}/${outcome.rules.values.tendency} (${outcome.rules.confidence})`,
    )}`,
    '',
  );
  const total = outcome.suggestions.reduce((s, b) => s + b.expectedPoints, 0);
  const rows = outcome.suggestions.map((b) => [
    fixture(b.home, b.away),
    b.pinned ? fg(palette.gold, `${b.bet} ${glyph.star}`) : fg(palette.primary, b.bet),
    dim(b.expectedPoints.toFixed(2)),
    b.existingBet ? dim(b.existingBet) : dim('—'),
    dim(truncate(b.reasoning, Math.max(20, width - 46))),
  ]);
  out.push(
    ...renderTable({
      width,
      columns: [
        { header: 'Match', flex: true, min: 14 },
        { header: 'Pick', align: 'center' },
        { header: 'xPts', align: 'right' },
        { header: 'Current', align: 'center' },
        { header: 'Why', flex: true, min: 12 },
      ],
      rows,
    }),
  );
  out.push('', `${dim('Expected points total')} ${bold(fg(palette.primary, total.toFixed(2)))}`);
  if (outcome.rules.warning) out.push(...note(outcome.rules.warning, width));
  return out;
}

// ── Stats ─────────────────────────────────────────────────────────

export function statsView(stats: SeasonStats, width: number): string[] {
  const out: string[] = [];
  const points = stats.form.map((f) => f.points);
  out.push(
    heading(`${stats.player} — season form`),
    `  ${sparkline(points, palette.primary)}  ${dim(
      `${stats.form.length} matchdays, mean ${fmt(stats.consistency.mean)} pts`,
    )}`,
    '',
  );

  const b = stats.breakdown;
  out.push(heading('Hit breakdown'));
  const total = b.scored || 1;
  out.push(
    hitBar('Exact', b.exact, total, palette.primary, width),
    hitBar('Goal diff', b.goalDiff, total, palette.teal, width),
    hitBar('Tendency', b.tendency, total, palette.accent, width),
    hitBar('Missed', b.miss, total, palette.red, width),
    dim(`  ${b.scored} matches scored · ${b.points} points under ${ruleTag(stats.rulesUsed)}`),
    '',
  );

  out.push(heading('Prediction profile'));
  const p = stats.betProfile;
  out.push(
    field('Predicted', outcomeSplit(p.predicted), 12),
    field('Actual', outcomeSplit(p.actual), 12),
    field('Avg goals', `${fmt(p.averagePredictedGoals)} predicted · ${fmt(p.averageActualGoals)} actual`, 12),
    field('Favourite', p.favouriteScoreline ?? '—', 12),
    '',
  );

  out.push(heading('Consistency & swings'));
  const c = stats.consistency;
  out.push(
    field('Std dev', fmt(c.standardDeviation), 12),
    field('Best MD', c.best ? `${c.best.points} pts (MD ${c.best.matchday})` : '—', 12),
    field('Worst MD', c.worst ? `${c.worst.points} pts (MD ${c.worst.matchday})` : '—', 12),
    field(
      'Below avg',
      c.belowAverageShare === null ? '—' : `${Math.round(c.belowAverageShare * 100)}% of matchdays`,
      12,
    ),
  );
  if (stats.biggestClimb) {
    out.push(
      field('Best climb', `${fg(palette.primary, `+${stats.biggestClimb.delta}`)} on MD ${stats.biggestClimb.matchday}`, 12),
    );
  }
  if (stats.biggestDrop) {
    out.push(
      field('Worst drop', `${fg(palette.red, `${stats.biggestDrop.delta}`)} on MD ${stats.biggestDrop.matchday}`, 12),
    );
  }
  out.push('', dim(`Data: ${stats.completeness.withBets} matchdays of bets, last sync ${syncAgo(stats.completeness.lastSync)}.`));
  return out;
}

function hitBar(label: string, value: number, total: number, color: readonly [number, number, number], width: number): string {
  const frac = total ? value / total : 0;
  const barWidth = Math.max(10, Math.min(28, width - 30));
  return `  ${dim(fit(label, 10))} ${bar(frac, barWidth, color as [number, number, number])} ${fit(String(value), 3, 'right')} ${dim(`${Math.round(frac * 100)}%`)}`;
}

function outcomeSplit(o: { home: number; draw: number; away: number }): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return `${pct(o.home)} home · ${pct(o.draw)} draw · ${pct(o.away)} away`;
}

function ruleTag(rules: { exact: number; goalDiff: number; tendency: number }): string {
  return `${rules.exact}/${rules.goalDiff}/${rules.tendency}`;
}

// ── Rival ─────────────────────────────────────────────────────────

export function rivalView(a: RivalAnalysis, width: number): string[] {
  const out: string[] = [];
  const gap =
    a.gap === null
      ? dim('gap unknown')
      : a.gap > 0
        ? fg(palette.primary, `+${a.gap} ahead`)
        : a.gap < 0
          ? fg(palette.red, `${a.gap} behind`)
          : dim('level');
  const md = a.matchday != null ? dim(` · matchday ${a.matchday}`) : '';
  out.push(
    `${bold(a.player)} ${dim('vs')} ${bold(a.rival)}   ${gap}   ${dim(`mode: ${a.mode}`)}${md}`,
    dim(`Swing still available: best +${a.swingRange.best}, worst ${a.swingRange.worst}`),
    '',
  );
  const rows = a.perMatch.map((m) => [
    fixture(m.home, m.away),
    m.myBet ? m.myBet : dim('—'),
    m.rivalBet ? m.rivalBet : dim('?'),
    swingCell(m.bestForMe, m.worstForMe, m.settled),
  ]);
  out.push(
    ...renderTable({
      width,
      columns: [
        { header: 'Match', flex: true, min: 16 },
        { header: 'You', align: 'center' },
        { header: a.rival, align: 'center' },
        { header: 'Swing', align: 'right' },
      ],
      rows,
    }),
    '',
    heading('What has to happen'),
  );
  out.push(...a.conditions.map((c) => `  ${fg(palette.primary, glyph.arrow)} ${wrapFirst(c, width - 4)}`));
  if (a.note) out.push('', ...note(a.note, width));
  return out;
}

function swingCell(best: number, worst: number, settled?: number): string {
  if (settled !== undefined) return settled >= 0 ? fg(palette.primary, `+${settled}`) : fg(palette.red, String(settled));
  return dim(`+${best} / ${worst}`);
}

// ── Scenario ──────────────────────────────────────────────────────

export function scenarioView(p: ScenarioProjection, width: number): string[] {
  const out: string[] = [];
  out.push(
    dim(`${p.specified} result(s) fixed · ${p.unspecified} open · ${p.exact ? 'exact' : 'range'} projection`),
    '',
  );
  const rows = p.players.map((row) => [
    row.rankBest === row.rankWorst ? bold(String(row.rankBest)) : `${row.rankBest}–${row.rankWorst}`,
    row.player,
    row.totalBest === row.totalWorst
      ? bold(String(row.totalBest))
      : `${row.totalWorst}–${row.totalBest}`,
    dim(row.matchdayBest === row.matchdayWorst ? `+${row.matchdayBest}` : `+${row.matchdayWorst}…${row.matchdayBest}`),
  ]);
  out.push(
    ...renderTable({
      width,
      columns: [
        { header: 'Rank', align: 'right' },
        { header: 'Player', flex: true, min: 12 },
        { header: 'Total', align: 'right' },
        { header: 'This MD', align: 'right' },
      ],
      rows,
    }),
  );
  if (p.note) out.push('', ...note(p.note, width));
  return out;
}

// ── Replay (what-if) ──────────────────────────────────────────────

export function replayView(r: ReplayResult, width: number): string[] {
  const out: string[] = [];
  const delta =
    r.delta === null
      ? dim('no baseline')
      : r.delta >= 0
        ? fg(palette.primary, `+${r.delta} vs actual`)
        : fg(palette.red, `${r.delta} vs actual`);
  out.push(
    `${dim('Strategy')} ${badge(r.strategy, palette.bg, palette.purple)}   ${dim('Total')} ${bold(
      String(r.total),
    )}   ${delta}`,
    dim(`${r.matchesScored} matches scored${r.finalRank ? ` · estimated rank ${r.finalRank}` : ''}`),
    '',
  );
  const rows = r.matchdays.map((m) => [
    String(m.matchday),
    bold(String(m.points)),
    m.actualPoints === null ? dim('—') : dim(String(m.actualPoints)),
    deltaCell(m.actualPoints === null ? null : m.points - m.actualPoints),
    dim(String(m.matches)),
  ]);
  out.push(
    ...renderTable({
      width,
      columns: [
        { header: 'MD', align: 'right' },
        { header: 'Replay', align: 'right' },
        { header: 'Actual', align: 'right' },
        { header: 'Δ', align: 'right' },
        { header: 'Matches', align: 'right' },
      ],
      rows,
    }),
  );
  if (r.rankNote) out.push('', ...note(r.rankNote, width));
  return out;
}

function deltaCell(delta: number | null): string {
  if (delta === null) return dim('—');
  if (delta > 0) return fg(palette.primary, `+${delta}`);
  if (delta < 0) return fg(palette.red, String(delta));
  return dim('0');
}

// ── Audit log ─────────────────────────────────────────────────────

export function auditView(records: AuditRecord[], width: number): string[] {
  if (!records.length) return empty('No submissions recorded yet.');
  const out: string[] = [];
  for (const rec of [...records].reverse()) {
    const when = new Date(rec.at).toLocaleString();
    const tag =
      rec.outcome === 'submitted'
        ? badge('submitted', palette.bg, palette.primary)
        : rec.outcome === 'dry-run'
          ? badge('dry-run', palette.bg, palette.accent)
          : badge(rec.outcome, palette.bg, palette.amber);
    out.push(
      `${tag} ${dim(when)} ${dim(glyph.dot)} ${fg(palette.accent, rec.source)}${
        rec.matchday ? dim(` · MD ${rec.matchday}`) : ''
      }${rec.onBehalfOf ? dim(` · for ${rec.onBehalfOf}`) : ''}`,
    );
    for (const bet of rec.bets) {
      const prev = bet.previous ? dim(` (was ${bet.previous})`) : '';
      out.push(`   ${dim(glyph.arrow)} ${truncate(bet.fixture, width - 18)} ${fg(palette.primary, bet.bet)}${prev}`);
    }
    out.push('');
  }
  return out;
}

// ── Bonus questions ───────────────────────────────────────────────

export function bonusView(answers: BonusAnswer[], width: number): string[] {
  if (!answers.length) {
    return empty('No bonus questions for this community, or the bonus round is closed.');
  }
  const anyOpen = answers.some((a) => a.editable);
  const out: string[] = [
    dim(anyOpen ? 'The bonus round is open — press e to answer a question.' : 'The bonus round is closed. Showing the bets you placed.'),
    '',
  ];
  answers.forEach((a, i) => {
    const status = !a.editable
      ? badge('locked', palette.bg, palette.faint)
      : a.answers.length
        ? badge('answered', palette.bg, palette.primary)
        : badge('open', palette.bg, palette.amber);
    out.push(`${fg(palette.accent, `${i + 1}.`)} ${bold(a.question)}  ${status}`);
    if (a.answers.length) {
      a.answers.forEach((ans, s) => {
        const slot = a.answers.length > 1 ? dim(` ${s + 1}.`) : '';
        out.push(`   ${fg(palette.primary, glyph.arrow)}${slot} ${fg(palette.primary, truncate(ans, width - 6))}`);
      });
    } else {
      out.push(`   ${dim(glyph.arrow)} ${dim(a.editable ? 'not answered yet' : 'no answer recorded')}`);
    }
    out.push('');
  });
  return out;
}

// ── Members (admin) ───────────────────────────────────────────────

export function membersView(members: Member[], width: number): string[] {
  if (!members.length) return empty('No members found (Spielleiter rights required).');
  return renderTable({
    width,
    zebra: true,
    columns: [
      { header: 'Member', flex: true, min: 12 },
      { header: 'tipperId', align: 'right' },
      { header: 'Type', align: 'right' },
    ],
    rows: members.map((m) => [
      m.name,
      dim(m.tipperId),
      m.dummy ? dim('dummy') : fg(palette.primary, 'player'),
    ]),
  });
}

// ── Cache & profiles ──────────────────────────────────────────────

export function cacheView(info: CacheInfo | null): string[] {
  if (!info) return empty('No community selected, so nothing is cached.');
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  const span = info.matchdays.length
    ? `${info.matchdays[0]}–${info.matchdays[info.matchdays.length - 1]} (${info.matchdays.length})`
    : 'none';
  return [
    field('Community', fg(palette.primary, info.community), 14),
    field('Location', dim(info.dir), 14),
    field('Size', kb(info.sizeBytes), 14),
    field('Last sync', syncAgo(info.lastSync), 14),
    field('Matchdays', span, 14),
    field('Season length', info.knownMatchdays ? String(info.knownMatchdays) : '—', 14),
  ];
}

export function profilesView(data: { active: string | null; profiles: string[] }): string[] {
  if (!data.profiles.length) {
    return empty('No named profiles. The default account is in use.');
  }
  return data.profiles.map(
    (name) =>
      `  ${name === data.active ? fg(palette.primary, glyph.check) : ' '} ${
        name === data.active ? bold(name) : name
      }`,
  );
}

// ── Guide ─────────────────────────────────────────────────────────

export function guideView(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (raw.startsWith('# ')) out.push(heading(raw.slice(2)));
    else if (raw.startsWith('## ')) out.push('', heading(raw.slice(3)));
    else if (raw.startsWith('### ')) out.push(bold(fg(palette.accent, raw.slice(4))));
    else if (/^\s{2,}\S/.test(raw)) out.push(fg(palette.teal, raw));
    else out.push(...(raw.trim() ? wrap(raw, width).map((l) => dim(l)) : ['']));
  }
  return out;
}

// ── Shared small helpers ──────────────────────────────────────────

function fmt(n: number | null): string {
  return n === null ? '—' : n.toFixed(2);
}

function syncAgo(iso: string | null): string {
  if (!iso) return 'never';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (60 * 24))}d ago`;
}

function wrapFirst(text: string, width: number): string {
  const lines = wrap(text, width);
  return lines.length > 1 ? `${lines[0]}…` : lines[0];
}

/** Used by the header to show a compact context strip. */
export function contextStrip(parts: { label: string; value: string }[]): string {
  return parts
    .map((p) => `${dim(p.label)} ${fg(palette.text, p.value)}`)
    .join(dim(`  ${glyph.v}  `));
}

export { fixture as fixtureLabel, italic as italicText, padLeft as padLeftText, visibleWidth as vw };
