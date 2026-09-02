import { renderScreen, type RenderOptions } from './render.js';
import { handleKey, type Key, type TuiState } from './state.js';

const CLEAR = '\x1b[2J\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

const ARROW_UP = '\x1b[A';
const ARROW_DOWN = '\x1b[B';
const BACKSPACE = '\x7f';
const CTRL_C = '\x03';

/** Translate a raw keypress into the state machine's vocabulary. */
export function decodeKey(chunk: string): Key | null {
  switch (chunk) {
    case ARROW_UP:
      return { type: 'up' };
    case ARROW_DOWN:
      return { type: 'down' };
    case '\r':
    case '\n':
      return { type: 'enter' };
    case BACKSPACE:
    case '\b':
      return { type: 'backspace' };
    case CTRL_C:
    case 'q':
      return { type: 'quit' };
    case 'w':
      return { type: 'submit' };
    case 'u':
      return { type: 'clear' };
    case 's':
      return { type: 'suggest' };
    case 'a':
      return { type: 'suggest-all' };
    default:
      return chunk.length === 1 ? { type: 'char', value: chunk } : null;
  }
}

/**
 * Run the screen until the user submits or quits, and return the final state.
 * The only place that touches the terminal.
 */
export function runScreen(initial: TuiState, options: RenderOptions): Promise<TuiState> {
  return new Promise((resolve) => {
    let state = initial;
    const input = process.stdin;
    const wasRaw = input.isRaw ?? false;

    const draw = (): void => {
      process.stdout.write(CLEAR + renderScreen(state, options).join('\n') + '\n');
    };

    const finish = (): void => {
      input.off('data', onData);
      if (input.isTTY) input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write(SHOW_CURSOR);
      resolve(state);
    };

    const onData = (chunk: Buffer | string): void => {
      const key = decodeKey(chunk.toString());
      if (key) state = handleKey(state, key);
      if (state.outcome) {
        process.stdout.write(CLEAR);
        finish();
        return;
      }
      draw();
    };

    if (input.isTTY) input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    process.stdout.write(HIDE_CURSOR);
    draw();
    input.on('data', onData);
  });
}
