/**
 * The visual language of the TUI: a small, deliberate palette and the box /
 * glyph set used everywhere. Keeping it in one place is what makes the whole
 * app feel like one thing rather than a pile of screens.
 *
 * The palette is a cool slate base with a green primary (Kicktipp's own
 * accent), an amber for warnings and a red for danger — chosen to stay
 * legible on both dark and light terminals.
 */
import type { Rgb } from './ansi.js';

export const palette = {
  // Surfaces
  bg: [17, 21, 28] as Rgb,
  panel: [24, 30, 40] as Rgb,
  panelAlt: [30, 37, 49] as Rgb,
  selection: [16, 84, 61] as Rgb,

  // Text
  text: [223, 230, 240] as Rgb,
  muted: [130, 143, 163] as Rgb,
  faint: [92, 103, 120] as Rgb,
  heading: [244, 248, 255] as Rgb,

  // Accents
  primary: [46, 204, 113] as Rgb,
  primaryDim: [33, 150, 83] as Rgb,
  accent: [88, 166, 255] as Rgb,
  gold: [241, 196, 15] as Rgb,
  amber: [230, 161, 60] as Rgb,
  red: [231, 76, 70] as Rgb,
  purple: [165, 130, 255] as Rgb,
  teal: [45, 212, 191] as Rgb,
} as const;

/** Box-drawing and iconography. Rounded corners read softer than square. */
export const glyph = {
  tl: '╭',
  tr: '╮',
  bl: '╰',
  br: '╯',
  h: '─',
  v: '│',
  vr: '├',
  vl: '┤',
  ht: '┬',
  hb: '┴',
  cross: '┼',

  bar: '█',
  barHalf: '▌',
  dot: '•',
  ring: '◦',
  arrow: '›',
  caret: '❯',
  check: '✓',
  cross_mark: '✗',
  warn: '▲',
  star: '★',
  clock: '◷',
  up: '▲',
  down: '▼',
  spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
} as const;

/** Spinner frames — braille dots, the calmest of the common animations. */
export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
