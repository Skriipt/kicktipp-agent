/**
 * String geometry for a terminal grid.
 *
 * Text handed around the renderer is often already wrapped in escape codes,
 * so every measurement strips them first: a padded column has to line up by
 * what the eye sees, not by how many bytes carry the colour.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** The escape codes removed, leaving only what is drawn. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Visible width in columns. Latin + box-drawing are all width 1, which is
 *  every glyph this app draws, so a code-point count is exact here. */
export function visibleWidth(text: string): number {
  return [...stripAnsi(text)].length;
}

/** Cut to `width`, adding an ellipsis when something was dropped. */
export function truncate(text: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  const plain = stripAnsi(text);
  const chars = [...plain];
  if (chars.length <= width) return text;
  if (width <= 1) return chars.slice(0, width).join('');
  return chars.slice(0, width - ellipsis.length).join('') + ellipsis;
}

export type Align = 'left' | 'right' | 'center';

/** Pad (or truncate) to an exact visible width, honouring alignment. The
 *  padding is added outside any escape codes so colour is not stretched. */
export function fit(text: string, width: number, align: Align = 'left'): string {
  const w = visibleWidth(text);
  if (w > width) return truncate(text, width);
  const gap = width - w;
  if (align === 'right') return ' '.repeat(gap) + text;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + text + ' '.repeat(gap - left);
  }
  return text + ' '.repeat(gap);
}

export const padRight = (text: string, width: number): string => fit(text, width, 'left');
export const padLeft = (text: string, width: number): string => fit(text, width, 'right');
export const center = (text: string, width: number): string => fit(text, width, 'center');

/** Greedy word wrap to a maximum visible width. Long words are hard-split. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (!line.length) {
        line = word;
      } else if (visibleWidth(line) + 1 + visibleWidth(word) <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
      while (visibleWidth(line) > width) {
        out.push([...line].slice(0, width).join(''));
        line = [...line].slice(width).join('');
      }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

/** Repeat a single glyph to fill a width (used for rules and bars). */
export function repeat(glyphChar: string, width: number): string {
  return width <= 0 ? '' : glyphChar.repeat(width);
}
