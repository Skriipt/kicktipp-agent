/**
 * Translate raw terminal input into a small, named key vocabulary.
 *
 * Kept separate from the app so navigation logic can be tested by feeding it
 * key objects, exactly like the existing betting screen does.
 */

export type Key =
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'enter' }
  | { type: 'escape' }
  | { type: 'tab' }
  | { type: 'shift-tab' }
  | { type: 'backspace' }
  | { type: 'space' }
  | { type: 'pageup' }
  | { type: 'pagedown' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'quit' }
  | { type: 'char'; value: string };

const MAP: Record<string, Key> = {
  '\x1b[A': { type: 'up' },
  '\x1bOA': { type: 'up' },
  '\x1b[B': { type: 'down' },
  '\x1bOB': { type: 'down' },
  '\x1b[C': { type: 'right' },
  '\x1bOC': { type: 'right' },
  '\x1b[D': { type: 'left' },
  '\x1bOD': { type: 'left' },
  '\x1b[5~': { type: 'pageup' },
  '\x1b[6~': { type: 'pagedown' },
  '\x1b[H': { type: 'home' },
  '\x1b[1~': { type: 'home' },
  '\x1b[F': { type: 'end' },
  '\x1b[4~': { type: 'end' },
  '\x1b[Z': { type: 'shift-tab' },
  '\r': { type: 'enter' },
  '\n': { type: 'enter' },
  '\t': { type: 'tab' },
  '\x7f': { type: 'backspace' },
  '\b': { type: 'backspace' },
  ' ': { type: 'space' },
  '\x1b': { type: 'escape' },
  '\x03': { type: 'quit' },
};

/** Decode one keypress chunk. Returns null for sequences we do not handle. */
export function decodeKey(chunk: string): Key | null {
  const mapped = MAP[chunk];
  if (mapped) return mapped;
  // A lone printable character (letters, digits, punctuation).
  if (chunk.length === 1 && chunk >= ' ' && chunk !== '\x7f') {
    return { type: 'char', value: chunk };
  }
  return null;
}
