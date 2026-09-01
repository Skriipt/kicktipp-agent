/**
 * A compact data table.
 *
 * Columns size themselves to their content, then give space back (widest
 * flexible column first) when the terminal is narrow, so a table never spills
 * past its panel. Cells may arrive pre-styled; widths are measured on the
 * visible text underneath.
 */
import { bold, dim, fg, paint, type Rgb } from './ansi.js';
import { palette } from './theme.js';
import { fit, visibleWidth, type Align } from './text.js';

export interface Column {
  header: string;
  align?: Align;
  /** Never shrink below this many columns. */
  min?: number;
  /** A wider column loses space first when trimming to fit. */
  flex?: boolean;
}

export interface TableOptions {
  columns: Column[];
  rows: string[][];
  /** Total width to fit within. */
  width: number;
  /** Alternate row shading for readability. */
  zebra?: boolean;
  /** Highlight one row (0-based over `rows`). */
  selected?: number;
  /** Per-row background tint, e.g. to mark the current player. */
  highlightRows?: Set<number>;
  gap?: number;
}

const GAP_DEFAULT = 2;

function naturalWidths(opts: TableOptions): number[] {
  return opts.columns.map((col, c) => {
    const cells = opts.rows.map((row) => visibleWidth(row[c] ?? ''));
    return Math.max(visibleWidth(col.header), ...cells, col.min ?? 0, 1);
  });
}

/** Shrink flexible columns (widest first) until the table fits `width`. */
function resolveWidths(opts: TableOptions): number[] {
  const gap = opts.gap ?? GAP_DEFAULT;
  const widths = naturalWidths(opts);
  const gaps = gap * (opts.columns.length - 1);
  let total = widths.reduce((a, b) => a + b, 0) + gaps;

  const flexible = opts.columns
    .map((col, i) => ({ i, flex: col.flex, min: col.min ?? 3 }))
    .filter((c) => c.flex);
  const pool = flexible.length
    ? flexible
    : opts.columns.map((_, i) => ({ i, flex: true, min: opts.columns[i].min ?? 3 }));

  while (total > opts.width) {
    pool.sort((a, b) => widths[b.i] - widths[a.i]);
    const widest = pool[0];
    if (!widest || widths[widest.i] <= widest.min) break;
    widths[widest.i]--;
    total--;
  }
  return widths;
}

export function renderTable(opts: TableOptions): string[] {
  const gap = opts.gap ?? GAP_DEFAULT;
  const widths = resolveWidths(opts);
  const gutter = ' '.repeat(gap);

  const header = opts.columns
    .map((col, c) => bold(fg(palette.muted, fit(col.header, widths[c], col.align ?? 'left'))))
    .join(gutter);

  const lines = [header];

  opts.rows.forEach((row, r) => {
    const cells = opts.columns.map((col, c) =>
      fit(row[c] ?? '', widths[c], col.align ?? 'left'),
    );
    const joined = cells.join(gutter);
    let line = joined;

    if (opts.selected === r) {
      line = paint(palette.heading, palette.selection, joined);
    } else if (opts.highlightRows?.has(r)) {
      line = paint(palette.gold, null, joined);
    } else if (opts.zebra && r % 2 === 1) {
      line = paint(null, palette.panelAlt, joined);
    }
    lines.push(line);
  });

  if (!opts.rows.length) lines.push(dim('  (nothing to show)'));
  return lines;
}
