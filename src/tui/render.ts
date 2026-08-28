import { widest } from '../helpers/output.js';
import { changedRows, isCompleteDraft, normalizeDraft, type TuiState } from './state.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const INVERT = '\x1b[7m';

export interface RenderOptions {
  title: string;
  /** Countdown to the next kickoff, when known. */
  deadline: string | null;
  /** Disables escape codes, which keeps the tests readable. */
  plain?: boolean;
}

/** The whole screen as lines. Pure, so the layout can be asserted on. */
export function renderScreen(state: TuiState, options: RenderOptions): string[] {
  const style = (code: string, text: string): string =>
    options.plain ? text : `${code}${text}${RESET}`;

  const lines: string[] = [];
  lines.push(style(BOLD, options.title));
  lines.push(
    options.deadline ? `Next kickoff ${options.deadline}` : 'No upcoming kickoff in this matchday.',
  );
  lines.push('');

  const fixtureWidth = widest(
    state.rows.map((row) => `${row.home} vs ${row.away}`),
    12,
  );

  state.rows.forEach((row, index) => {
    const selected = index === state.cursor;
    const fixture = `${row.home} vs ${row.away}`.padEnd(fixtureWidth);

    let field: string;
    if (!row.editable) field = ' closed ';
    else if (row.draft) field = ` ${normalizeDraft(row.draft).padEnd(5)} `;
    else field = '  _:_   ';

    const changed =
      row.editable && isCompleteDraft(row.draft) && normalizeDraft(row.draft) !== row.saved;
    const marker = changed ? '*' : ' ';
    const saved = row.saved ? `was ${row.saved}` : row.editable ? 'no bet yet' : '';
    const hint = row.suggestion && !row.draft ? `suggests ${row.suggestion}` : '';

    const body =
      `${marker} ${fixture}  ${selected ? style(INVERT, field) : field}  ` +
      style(DIM, `${saved.padEnd(12)} ${hint}`);
    lines.push(selected ? `> ${body}` : `  ${body}`);
  });

  lines.push('');
  const pending = changedRows(state).length;
  lines.push(
    pending
      ? style(BOLD, `${pending} bet(s) ready to submit (marked *)`)
      : style(DIM, 'No changes yet.'),
  );
  lines.push(
    style(
      DIM,
      'up/down move   digits type a score   s take suggestion   a fill all   u clear   w submit   q quit',
    ),
  );
  if (state.message) lines.push(state.message);
  return lines;
}
