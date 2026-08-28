import { describe, it, expect } from 'vitest';
import {
  changedRows,
  handleKey,
  initialState,
  isCompleteDraft,
  isDirty,
  normalizeDraft,
  type TuiRow,
  type TuiState,
} from '../src/tui/state.js';
import { renderScreen } from '../src/tui/render.js';
import { decodeKey } from '../src/tui/screen.js';

function row(over: Partial<TuiRow> = {}): TuiRow {
  return {
    home: 'Bayern',
    away: 'BVB',
    kickoff: null,
    saved: null,
    draft: '',
    suggestion: '2:1',
    odds: '1.50',
    editable: true,
    ...over,
  };
}

function state(rows: TuiRow[] = [row(), row({ home: 'Freiburg', away: 'VfB' })]): TuiState {
  return initialState(rows);
}

function type(start: TuiState, chars: string): TuiState {
  return [...chars].reduce((s, value) => handleKey(s, { type: 'char', value }), start);
}

describe('typing a score', () => {
  it('reads two bare digits as a scoreline', () => {
    // The raw keystrokes are kept; the separator appears on screen and when
    // the bet is submitted.
    const after = type(state(), '21');
    expect(after.rows[0].draft).toBe('21');
    expect(normalizeDraft(after.rows[0].draft)).toBe('2:1');
    expect(isCompleteDraft(after.rows[0].draft)).toBe(true);
  });

  it('accepts an explicit separator for double-digit scores', () => {
    const after = type(state(), '10:0');
    expect(after.rows[0].draft).toBe('10:0');
    expect(isCompleteDraft(after.rows[0].draft)).toBe(true);
  });

  it('keeps appending rather than guessing, so 10:0 is reachable', () => {
    // "21" already reads as 2:1, but a third digit must not silently restart
    // or the two-digit scores would be unreachable.
    expect(type(state(), '213').rows[0].draft).toBe('213');
    expect(isCompleteDraft('213')).toBe(false);
  });

  it('stops accepting characters once the field is full', () => {
    expect(type(state(), '1234567').rows[0].draft).toHaveLength(5);
  });

  it('ignores characters that are not part of a score', () => {
    expect(type(state(), 'x!').rows[0].draft).toBe('');
  });

  it('deletes with backspace', () => {
    const after = handleKey(type(state(), '21'), { type: 'backspace' });
    expect(after.rows[0].draft).toBe('2');
  });

  it('does not edit a closed match', () => {
    const closed = state([row({ editable: false })]);
    expect(type(closed, '21').rows[0].draft).toBe('');
  });
});

describe('navigation', () => {
  it('moves between rows and wraps around', () => {
    let s = state();
    expect(s.cursor).toBe(0);
    s = handleKey(s, { type: 'down' });
    expect(s.cursor).toBe(1);
    s = handleKey(s, { type: 'down' });
    expect(s.cursor).toBe(0);
    s = handleKey(s, { type: 'up' });
    expect(s.cursor).toBe(1);
  });

  it('skips closed matches', () => {
    const s = state([row({ editable: false }), row({ home: 'Freiburg' })]);
    // Starts on the first editable row, and stays there when moving.
    expect(s.cursor).toBe(1);
    expect(handleKey(s, { type: 'down' }).cursor).toBe(1);
  });

  it('treats Enter as move-on', () => {
    expect(handleKey(state(), { type: 'enter' }).cursor).toBe(1);
  });
});

describe('suggestions', () => {
  it('adopts the suggestion for the current row', () => {
    expect(handleKey(state(), { type: 'suggest' }).rows[0].draft).toBe('2:1');
  });

  it('fills every empty row at once, leaving typed ones alone', () => {
    const typed = type(state(), '30');
    const filled = handleKey(typed, { type: 'suggest-all' });
    expect(normalizeDraft(filled.rows[0].draft)).toBe('3:0');
    expect(filled.rows[1].draft).toBe('2:1');
    expect(filled.message).toMatch(/Filled every empty match/);
  });

  it('does nothing when a row has no suggestion', () => {
    const s = state([row({ suggestion: null })]);
    expect(handleKey(s, { type: 'suggest' }).rows[0].draft).toBe('');
  });
});

describe('what counts as a change', () => {
  it('ignores an incomplete draft', () => {
    const partial = type(state(), '2');
    expect(isDirty(partial)).toBe(false);
    expect(changedRows(partial)).toEqual([]);
  });

  it('ignores a draft identical to what is already stored', () => {
    expect(isDirty(state([row({ saved: '2:1', draft: '2:1' })]))).toBe(false);
    // ...including the un-separated spelling of the same score.
    expect(isDirty(state([row({ saved: '2:1', draft: '21' })]))).toBe(false);
  });

  it('counts a genuine edit', () => {
    const start = state([row({ saved: '2:1', draft: '' })]);
    const edited = type(start, '30');
    expect(changedRows(edited)).toHaveLength(1);
    expect(normalizeDraft(changedRows(edited)[0].draft)).toBe('3:0');
  });

  it('clears a draft with u', () => {
    const cleared = handleKey(type(state(), '21'), { type: 'clear' });
    expect(cleared.rows[0].draft).toBe('');
  });
});

describe('leaving the screen', () => {
  it('submits when there is something to submit', () => {
    const ready = type(state(), '21');
    expect(handleKey(ready, { type: 'submit' }).outcome).toBe('submit');
  });

  it('refuses to submit nothing, and says why', () => {
    const after = handleKey(state(), { type: 'submit' });
    expect(after.outcome).toBeNull();
    expect(after.message).toMatch(/no bets have changed/i);
  });

  it('quits straight away when nothing is unsaved', () => {
    expect(handleKey(state(), { type: 'quit' }).outcome).toBe('quit');
  });

  it('asks before discarding unsaved edits', () => {
    const dirty = type(state(), '21');
    const asked = handleKey(dirty, { type: 'quit' });
    expect(asked.outcome).toBeNull();
    expect(asked.confirmingQuit).toBe(true);
    expect(asked.message).toMatch(/unsaved/i);
    // A second q goes through.
    expect(handleKey(asked, { type: 'quit' }).outcome).toBe('quit');
  });

  it('cancels the pending question as soon as editing resumes', () => {
    const asked = handleKey(type(state(), '21'), { type: 'quit' });
    expect(handleKey(asked, { type: 'down' }).confirmingQuit).toBe(false);
  });

  it('ignores keys once the outcome is decided', () => {
    const done = handleKey(state(), { type: 'quit' });
    expect(handleKey(done, { type: 'char', value: '2' })).toBe(done);
  });
});

describe('rendering', () => {
  const options = { title: 'Matchday 5', deadline: 'in 2h 0m', plain: true };

  it('shows the fixtures, the cursor and the empty field', () => {
    const lines = renderScreen(state(), options).join('\n');
    expect(lines).toContain('Matchday 5');
    expect(lines).toContain('Next kickoff in 2h 0m');
    expect(lines).toContain('Bayern vs BVB');
    expect(lines).toContain('_:_');
    expect(lines).toContain('> ');
  });

  it('marks changed rows and counts them', () => {
    const lines = renderScreen(type(state(), '21'), options).join('\n');
    expect(lines).toContain('* Bayern vs BVB');
    expect(lines).toContain('1 bet(s) ready to submit');
  });

  it('shows what was already stored and what is suggested', () => {
    const lines = renderScreen(state([row({ saved: '1:1' })]), options).join('\n');
    expect(lines).toContain('was 1:1');
    expect(lines).toContain('suggests 2:1');
  });

  it('marks a closed match instead of offering a field', () => {
    const lines = renderScreen(state([row({ editable: false })]), options).join('\n');
    expect(lines).toContain('closed');
    expect(lines).not.toContain('_:_');
  });

  it('emits escape codes only when not asked for plain output', () => {
    expect(renderScreen(state(), { ...options, plain: false }).join('')).toContain('\x1b[');
    expect(renderScreen(state(), options).join('')).not.toContain('\x1b[');
  });
});

describe('key decoding', () => {
  it('maps the keys the screen documents', () => {
    expect(decodeKey('\x1b[A')).toEqual({ type: 'up' });
    expect(decodeKey('\x1b[B')).toEqual({ type: 'down' });
    expect(decodeKey('\r')).toEqual({ type: 'enter' });
    expect(decodeKey('\x7f')).toEqual({ type: 'backspace' });
    expect(decodeKey('w')).toEqual({ type: 'submit' });
    expect(decodeKey('q')).toEqual({ type: 'quit' });
    expect(decodeKey('\x03')).toEqual({ type: 'quit' });
    expect(decodeKey('s')).toEqual({ type: 'suggest' });
    expect(decodeKey('a')).toEqual({ type: 'suggest-all' });
    expect(decodeKey('u')).toEqual({ type: 'clear' });
    expect(decodeKey('2')).toEqual({ type: 'char', value: '2' });
  });

  it('ignores escape sequences it does not know', () => {
    expect(decodeKey('\x1b[5~')).toBeNull();
  });
});

describe('isCompleteDraft', () => {
  it('accepts a full scoreline only', () => {
    expect(isCompleteDraft('2:1')).toBe(true);
    expect(isCompleteDraft('10:0')).toBe(true);
    expect(isCompleteDraft('21')).toBe(true);
    expect(isCompleteDraft('2:')).toBe(false);
    expect(isCompleteDraft('213')).toBe(false);
    expect(isCompleteDraft('')).toBe(false);
  });

  it('normalizes only what is unambiguous', () => {
    expect(normalizeDraft('21')).toBe('2:1');
    expect(normalizeDraft('10:0')).toBe('10:0');
    expect(normalizeDraft('213')).toBe('213');
  });
});
