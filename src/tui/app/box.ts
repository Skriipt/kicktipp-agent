/**
 * Panels, rules, bars and badges — the reusable chrome that gives every
 * screen the same frame. All of it is pure: strings in, styled strings out,
 * so layouts can be asserted on in tests.
 */
import { fg, dim, bold, paint, type Rgb } from './ansi.js';
import { palette, glyph } from './theme.js';
import { fit, visibleWidth, repeat } from './text.js';

export interface PanelOptions {
  /** Total width including the two border columns. */
  width: number;
  title?: string;
  /** Right-aligned label in the top border, e.g. a count or a hint. */
  badge?: string;
  color?: Rgb;
  /** Dim the border, for secondary panels. */
  subtle?: boolean;
}

/** Draw a rounded panel around already-rendered content lines. */
export function panel(lines: string[], opts: PanelOptions): string[] {
  const inner = Math.max(0, opts.width - 2);
  const borderColor = opts.color ?? (opts.subtle ? palette.faint : palette.primaryDim);
  const b = (s: string): string => fg(borderColor, s);

  const top = topBorder(inner, borderColor, opts.title, opts.badge);
  const body = lines.map((line) => `${b(glyph.v)}${fit(line, inner)}${b(glyph.v)}`);
  const bottom = `${b(glyph.bl)}${b(repeat(glyph.h, inner))}${b(glyph.br)}`;
  return [top, ...body, bottom];
}

function topBorder(inner: number, color: Rgb, title?: string, badge?: string): string {
  const b = (s: string): string => fg(color, s);
  if (!title && !badge) {
    return `${b(glyph.tl)}${b(repeat(glyph.h, inner))}${b(glyph.tr)}`;
  }
  const left = title ? ` ${bold(fg(palette.heading, title))} ` : '';
  const right = badge ? ` ${dim(badge)} ` : '';
  const used = visibleWidth(left) + visibleWidth(right);
  const fill = Math.max(0, inner - used - 2);
  const middle = `${b(glyph.h)}${left}${b(repeat(glyph.h, fill))}${right}${b(glyph.h)}`;
  return `${b(glyph.tl)}${fit(middle, inner)}${b(glyph.tr)}`;
}

/** A horizontal rule with an optional inline label. */
export function rule(width: number, label?: string, color: Rgb = palette.faint): string {
  if (!label) return fg(color, repeat(glyph.h, width));
  const tag = ` ${label} `;
  const rest = Math.max(0, width - visibleWidth(tag));
  const left = Math.floor(rest / 2);
  return fg(color, repeat(glyph.h, left)) + dim(tag) + fg(color, repeat(glyph.h, rest - left));
}

/** A filled progress/percentage bar of a given width. The empty portion uses
 *  a lighter glyph so the level reads even when colour is unavailable. */
export function bar(fraction: number, width: number, color: Rgb = palette.primary): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * width);
  return fg(color, repeat(glyph.bar, filled)) + fg(palette.panelAlt, repeat('░', width - filled));
}

/** A sparkline from a series of numbers, scaled to the block glyphs. */
export function sparkline(values: (number | null)[], color: Rgb = palette.primary): string {
  const present = values.filter((v): v is number => v !== null);
  if (!present.length) return '';
  const min = Math.min(...present);
  const max = Math.max(...present);
  const span = max - min || 1;
  return values
    .map((v) => {
      if (v === null) return dim(' ');
      const idx = Math.round(((v - min) / span) * (glyph.spark.length - 1));
      return fg(color, glyph.spark[idx]);
    })
    .join('');
}

/** A small rounded pill, for statuses and tags. */
export function badge(text: string, fgColor: Rgb, bgColor: Rgb): string {
  return paint(fgColor, bgColor, ` ${text} `);
}

/** Center a block of lines within a width by left-padding each line. */
export function indentBlock(lines: string[], left: number): string[] {
  const pad = ' '.repeat(Math.max(0, left));
  return lines.map((line) => pad + line);
}

/** A two-column key/value row, key dimmed and padded to `keyWidth`. The value
 *  is appended as-is; the caller sizes it, and the panel clips any overflow. */
export function field(key: string, value: string, keyWidth: number): string {
  return `  ${dim(fit(key, keyWidth))}  ${value}`;
}
