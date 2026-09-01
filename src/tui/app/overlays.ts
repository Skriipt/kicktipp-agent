/**
 * Modal overlays: confirm, text input, a searchable list picker and a plain
 * message box. Each is a small self-contained state machine the app renders
 * centred over the current screen and feeds keys to while it is open.
 */
import { bold, dim, fg, invert } from './ansi.js';
import { palette, glyph } from './theme.js';
import { fit, truncate, wrap } from './text.js';
import type { AppApi, Overlay } from './types.js';

export function messageOverlay(
  app: AppApi,
  opts: { title: string; lines: string[]; color?: readonly [number, number, number]; width?: number },
): Overlay {
  return {
    title: opts.title,
    width: opts.width ?? 62,
    color: opts.color as [number, number, number] | undefined,
    footer: 'enter / esc  close',
    render: (inner) => opts.lines.flatMap((line) => wrap(line, inner)),
    onKey: (key) => {
      if (key.type === 'enter' || key.type === 'escape' || key.type === 'quit') app.closeOverlay();
    },
  };
}

export function confirmOverlay(
  app: AppApi,
  opts: { title: string; message: string; danger?: boolean; onConfirm: () => void | Promise<void> },
): Overlay {
  return {
    title: opts.title,
    width: 58,
    color: opts.danger ? palette.red : palette.primary,
    footer: `${bold('y')} confirm    ${bold('n')} cancel`,
    render: (inner) => [...wrap(opts.message, inner), ''],
    onKey: async (key) => {
      if (key.type === 'char' && (key.value === 'y' || key.value === 'Y')) {
        app.closeOverlay();
        await opts.onConfirm();
      } else if (key.type === 'enter') {
        app.closeOverlay();
        await opts.onConfirm();
      } else if (key.type === 'escape' || key.type === 'quit' || (key.type === 'char' && /[nN]/.test(key.value))) {
        app.closeOverlay();
      }
    },
  };
}

export function inputOverlay(
  app: AppApi,
  opts: {
    title: string;
    prompt: string;
    initial?: string;
    password?: boolean;
    placeholder?: string;
    onSubmit: (value: string) => void | Promise<void>;
  },
): Overlay {
  let value = opts.initial ?? '';
  return {
    title: opts.title,
    width: 64,
    footer: `${bold('enter')} save    ${bold('esc')} cancel`,
    render: (inner) => {
      const shown = opts.password ? '•'.repeat(value.length) : value;
      const display = shown.length ? shown : dim(opts.placeholder ?? '');
      const box = ` ${fit(display, inner - 4)} `;
      return [dim(opts.prompt), '', fg(palette.accent, glyph.arrow) + ' ' + invert(box)];
    },
    onKey: async (key) => {
      if (key.type === 'char') value += key.value;
      else if (key.type === 'space') value += ' ';
      else if (key.type === 'backspace') value = value.slice(0, -1);
      else if (key.type === 'enter') {
        app.closeOverlay();
        await opts.onSubmit(value.trim());
      } else if (key.type === 'escape' || key.type === 'quit') app.closeOverlay();
    },
  };
}

export function listOverlay(
  app: AppApi,
  opts: {
    title: string;
    items: string[];
    initial?: number;
    emptyMessage?: string;
    onSelect: (value: string, index: number) => void | Promise<void>;
  },
): Overlay {
  let query = '';
  let cursor = opts.initial ?? 0;
  const MAX_VISIBLE = 12;

  const filtered = (): { value: string; index: number }[] =>
    opts.items
      .map((value, index) => ({ value, index }))
      .filter(({ value }) => value.toLowerCase().includes(query.toLowerCase()));

  return {
    title: opts.title,
    width: 60,
    footer: `${bold('↑↓')} move   ${bold('type')} filter   ${bold('enter')} select   ${bold('esc')} cancel`,
    render: (inner) => {
      const matches = filtered();
      if (cursor >= matches.length) cursor = Math.max(0, matches.length - 1);
      const out: string[] = [];
      out.push(`${dim('search')} ${query ? fg(palette.text, query) : dim('(type to filter)')}`, '');
      if (!matches.length) {
        out.push(dim(`  ${opts.emptyMessage ?? 'No matches.'}`));
        return out;
      }
      const start = Math.max(0, Math.min(cursor - Math.floor(MAX_VISIBLE / 2), matches.length - MAX_VISIBLE));
      const window = matches.slice(Math.max(0, start), Math.max(0, start) + MAX_VISIBLE);
      for (const { value } of window) {
        const isCursor = matches[cursor]?.value === value;
        const line = ` ${truncate(value, inner - 3)} `;
        out.push(isCursor ? fg(palette.heading, invert(line)) : `  ${fg(palette.text, truncate(value, inner - 3))}`);
      }
      if (matches.length > MAX_VISIBLE) out.push(dim(`  … ${matches.length} matches`));
      return out;
    },
    onKey: async (key) => {
      const matches = filtered();
      if (key.type === 'up') cursor = (cursor - 1 + matches.length) % Math.max(1, matches.length);
      else if (key.type === 'down') cursor = (cursor + 1) % Math.max(1, matches.length);
      else if (key.type === 'char') {
        query += key.value;
        cursor = 0;
      } else if (key.type === 'backspace') {
        query = query.slice(0, -1);
        cursor = 0;
      } else if (key.type === 'enter') {
        const chosen = matches[cursor];
        if (chosen) {
          app.closeOverlay();
          await opts.onSelect(chosen.value, chosen.index);
        }
      } else if (key.type === 'escape' || key.type === 'quit') app.closeOverlay();
    },
  };
}
