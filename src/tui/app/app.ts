/**
 * The application shell: layout, focus, input routing and the redraw loop.
 *
 * It owns the terminal (alt screen + raw mode) and composes four regions on
 * every frame — a brand bar, the navigation sidebar, the content pane and a
 * footer with key hints and a transient toast. Screens and overlays supply
 * the inner content; everything about *where* it goes lives here.
 */
import {
  CSI,
  clearScreen,
  detectColor,
  dim,
  bold,
  enterAltScreen,
  exitAltScreen,
  fg,
  hideCursor,
  home,
  moveTo,
  paint,
  showCursor,
} from './ansi.js';
import { palette, glyph, spinnerFrames } from './theme.js';
import { fit, padRight, truncate, visibleWidth } from './text.js';
import { panel } from './box.js';
import { MENU, flatItems } from './menu.js';
import { decodeKey, type Key } from './keys.js';
import { createScreen } from './screens.js';
import type { AppApi, Overlay, Screen, ToastLevel } from './types.js';
import type { DataSource } from './source.js';

const SIDEBAR_WIDTH = 26;
const BRAND_ROWS = 1;
const FOOTER_ROWS = 2;
const TOAST_MS = 4000;

interface Size {
  rows: number;
  cols: number;
}

export class App implements AppApi {
  readonly source: DataSource;
  matchday: number | null = null;

  private size: Size = { rows: 24, cols: 80 };
  private focus: 'nav' | 'content' = 'nav';
  private navIndex = 0;
  private screen: Screen;
  private overlay: Overlay | null = null;
  private scroll = 0;
  private navScroll = 0;
  private loading = false;
  private lastContentHeight = 0;
  private toastState: { message: string; level: ToastLevel; until: number } | null = null;

  private queue: Key[] = [];
  private busy = false;
  private running = false;
  private resolveRun: (() => void) | null = null;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private spinnerFrame = 0;
  private toastTimer: NodeJS.Timeout | null = null;
  private readonly onData = (chunk: Buffer | string): void => this.handleChunk(chunk.toString());
  private readonly onResize = (): void => {
    this.measure();
    this.render();
  };

  constructor(source: DataSource, opts: { matchday?: number | null } = {}) {
    this.source = source;
    this.matchday = opts.matchday ?? null;
    this.screen = createScreen(this, flatItems()[0].id);
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async run(): Promise<void> {
    detectColor();
    this.measure();
    const input = process.stdin;
    this.ownInput();
    input.setEncoding('utf8');
    process.stdout.write(enterAltScreen + hideCursor + clearScreen);
    input.on('data', this.onData);
    process.stdout.on('resize', this.onResize);

    this.running = true;
    try {
      await this.loadScreen(); // first screen (today)
      this.render();
      await new Promise<void>((resolve) => {
        this.resolveRun = resolve;
      });
    } catch (err) {
      this.quit();
      throw err;
    }
  }

  /** Raw mode + flowing stdin. Re-applied after any CLI spinner, because
   *  ora's stdin-discarder pauses stdin and turns raw mode off when it stops. */
  private ownInput(): void {
    const input = process.stdin;
    if (input.isTTY) input.setRawMode(true);
    input.resume();
  }

  quit(): void {
    if (!this.running) return;
    this.running = false;
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    const input = process.stdin;
    input.off('data', this.onData);
    process.stdout.off('resize', this.onResize);
    if (input.isTTY) input.setRawMode(false);
    input.pause();
    process.stdout.write(showCursor + exitAltScreen);
    this.resolveRun?.();
  }

  // ── AppApi ──────────────────────────────────────────────────────

  toast(message: string, level: ToastLevel = 'info'): void {
    this.toastState = { message, level, until: Date.now() + TOAST_MS };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastState = null;
      this.render();
    }, TOAST_MS);
    this.render();
  }

  openOverlay(overlay: Overlay): void {
    this.overlay = overlay;
    this.render();
  }

  closeOverlay(): void {
    this.overlay = null;
    this.render();
  }

  async reload(): Promise<void> {
    await this.loadScreen();
    this.render();
  }

  async goto(id: string): Promise<void> {
    this.screen = createScreen(this, id);
    this.scroll = 0;
    await this.loadScreen();
    this.focus = 'content';
    this.render();
  }

  async setMatchday(matchday: number | null): Promise<void> {
    this.matchday = matchday;
    if (this.screen.matchdayScoped) await this.reload();
    else this.render();
  }

  refreshContext(): void {
    this.render();
  }

  focusSidebar(): void {
    this.focus = 'nav';
    this.render();
  }

  requestRedraw(): void {
    this.render();
  }

  // ── Loading ─────────────────────────────────────────────────────

  private async loadScreen(): Promise<void> {
    this.loading = true;
    this.scroll = 0;
    this.startSpinner();
    try {
      await this.screen.load();
    } catch (err) {
      this.toastState = {
        message: err instanceof Error ? err.message : String(err),
        level: 'error',
        until: Date.now() + TOAST_MS * 2,
      };
    } finally {
      this.loading = false;
      this.stopSpinner();
      this.ownInput();
    }
  }

  private startSpinner(): void {
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % spinnerFrames.length;
      if (this.loading) this.render();
    }, 90);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  // ── Input ───────────────────────────────────────────────────────

  private handleChunk(chunk: string): void {
    // A paste or fast key can arrive as several sequences at once.
    let rest = chunk;
    while (rest.length) {
      const consumed = takeKey(rest);
      const key = decodeKey(consumed.raw);
      if (key) this.queue.push(key);
      rest = consumed.remainder;
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const key = this.queue.shift()!;
        await this.dispatch(key);
        if (!this.running) return;
      }
    } finally {
      this.busy = false;
    }
  }

  private async dispatch(key: Key): Promise<void> {
    if (key.type === 'quit') {
      this.quit();
      return;
    }

    if (this.overlay) {
      await this.overlay.onKey(key);
      this.render();
      return;
    }

    if (this.focus === 'nav') {
      await this.navKey(key);
      return;
    }

    await this.contentKey(key);
  }

  private async navKey(key: Key): Promise<void> {
    const items = flatItems();
    switch (key.type) {
      case 'up':
        this.navIndex = (this.navIndex - 1 + items.length) % items.length;
        break;
      case 'down':
        this.navIndex = (this.navIndex + 1) % items.length;
        break;
      case 'home':
        this.navIndex = 0;
        break;
      case 'end':
        this.navIndex = items.length - 1;
        break;
      case 'enter':
      case 'right':
      case 'tab':
        await this.goto(items[this.navIndex].id);
        return;
      case 'char':
        if (key.value === '?') return this.showHelp();
        if (key.value === 'q') return this.quit();
        break;
      default:
        break;
    }
    this.render();
  }

  private async contentKey(key: Key): Promise<void> {
    const captures = this.screen.capturesInput?.() ?? false;

    if (captures) {
      // The screen wants raw keys; only help stays global.
      if (key.type === 'char' && key.value === '?') return this.showHelp();
      await this.screen.onKey(key);
      this.render();
      return;
    }

    // Read screens: the app scrolls and handles global keys, the screen gets
    // whatever is left (its toggle keys).
    const page = Math.max(1, this.contentInnerHeight() - 2);
    switch (key.type) {
      case 'up':
        this.scroll = Math.max(0, this.scroll - 1);
        return this.render();
      case 'down':
        this.scroll = this.clampScroll(this.scroll + 1);
        return this.render();
      case 'pageup':
        this.scroll = Math.max(0, this.scroll - page);
        return this.render();
      case 'pagedown':
        this.scroll = this.clampScroll(this.scroll + page);
        return this.render();
      case 'home':
        this.scroll = 0;
        return this.render();
      case 'end':
        this.scroll = this.clampScroll(Number.MAX_SAFE_INTEGER);
        return this.render();
      case 'left':
      case 'escape':
        return this.focusSidebar();
      case 'tab':
        return this.focusSidebar();
      case 'char':
        if (key.value === '?') return this.showHelp();
        if (key.value === 'q') return this.quit();
        if ((key.value === '[' || key.value === ',') && this.screen.matchdayScoped) {
          return this.stepMatchday(-1);
        }
        if ((key.value === ']' || key.value === '.') && this.screen.matchdayScoped) {
          return this.stepMatchday(1);
        }
        break;
      default:
        break;
    }
    const handled = await this.screen.onKey(key);
    if (handled) this.render();
  }

  private async stepMatchday(delta: number): Promise<void> {
    const base = this.matchday ?? currentGuess();
    const next = Math.min(34, Math.max(1, base + delta));
    await this.setMatchday(next);
  }

  private showHelp(): void {
    this.openOverlay({
      title: 'Keyboard shortcuts',
      width: 60,
      footer: 'esc  close',
      render: () => [
        row('↑ ↓', 'move / scroll'),
        row('enter →', 'open the highlighted screen'),
        row('esc ←', 'back to the menu'),
        row('tab', 'switch focus'),
        row('[ ]', 'previous / next matchday'),
        row('? ', 'this help'),
        row('q', 'quit'),
        '',
        dim('Screen-specific keys appear in the footer.'),
      ],
      onKey: (key) => {
        if (key.type === 'escape' || key.type === 'enter' || key.type === 'quit') this.closeOverlay();
      },
    });
  }

  // ── Layout & rendering ──────────────────────────────────────────

  private measure(): void {
    this.size = {
      rows: process.stdout.rows || 24,
      cols: process.stdout.columns || 80,
    };
  }

  private mainHeight(): number {
    return Math.max(3, this.size.rows - BRAND_ROWS - FOOTER_ROWS);
  }

  private contentWidth(): number {
    return Math.max(20, this.size.cols - SIDEBAR_WIDTH - 1);
  }

  private contentInnerHeight(): number {
    // main panel minus its 2 borders, minus status line + spacer.
    return Math.max(1, this.mainHeight() - 2 - 2);
  }

  private clampScroll(value: number): number {
    const max = Math.max(0, this.lastContentHeight - this.contentInnerHeight());
    return Math.min(max, Math.max(0, value));
  }

  private render(): void {
    if (!this.running) return;
    const clipped = this.composeFrame();
    process.stdout.write(home + clipped.join(`${CSI}K\n`) + `${CSI}K` + `${CSI}J`);
  }

  /** Build the full frame as clipped lines. Pure: no terminal writes, so it
   *  is used by both render() and the tests/headless preview. */
  private composeFrame(): string[] {
    const { rows, cols } = this.size;
    const lines: string[] = [];
    lines.push(this.renderBrand());
    for (const line of this.renderMain()) lines.push(line);
    for (const line of this.renderFooter()) lines.push(line);
    if (this.overlay) this.compositeOverlay(lines);
    return lines.slice(0, rows).map((l) => fit(l, cols));
  }

  // ── Test / headless-preview hooks ───────────────────────────────

  /** Set the viewport without a terminal, for tests and previews. */
  setViewport(rows: number, cols: number): void {
    this.size = { rows, cols };
  }

  /** Load a screen by id and return the composed frame, no terminal needed. */
  async snapshot(id: string): Promise<string[]> {
    this.screen = createScreen(this, id);
    this.scroll = 0;
    try {
      await this.screen.load();
    } catch (err) {
      this.toastState = {
        message: err instanceof Error ? err.message : String(err),
        level: 'error',
        until: Date.now(),
      };
    }
    this.focus = 'content';
    return this.composeFrame();
  }

  private renderBrand(): string {
    const ctx = this.source.getContext();
    const left = ` ${glyph.star} ${bold('kicktipp')} ${dim('control room')} `;
    const mode = ctx.demo ? ' DEMO ' : ctx.readOnly ? ' READ-ONLY ' : '';
    const right = `${mode ? paint(palette.bg, palette.gold, mode) + ' ' : ''}${dim(
      ctx.community ?? 'no community',
    )} `;
    const gap = Math.max(1, this.size.cols - visibleWidth(left) - visibleWidth(right));
    return paint(palette.heading, palette.panelAlt, left + ' '.repeat(gap) + right);
  }

  private renderMain(): string[] {
    const height = this.mainHeight();
    const sidebar = this.renderSidebar(height);
    const content = this.renderContent(height);
    const out: string[] = [];
    for (let i = 0; i < height; i++) {
      out.push(`${sidebar[i] ?? ' '.repeat(SIDEBAR_WIDTH)} ${content[i] ?? ''}`);
    }
    return out;
  }

  private renderSidebar(height: number): string[] {
    const inner: string[] = [];
    const items = flatItems();
    let flatIndex = 0;
    for (const group of MENU) {
      inner.push(dim(group.title.toUpperCase()));
      for (const item of group.items) {
        const selected = flatIndex === this.navIndex;
        const isCurrent = item.id === this.screen.id;
        const caret = selected ? fg(palette.primary, glyph.caret) : ' ';
        const label = `${item.icon} ${item.label}`;
        const marker = isCurrent ? fg(palette.primary, glyph.dot) : ' ';
        let line = `${caret} ${label} ${marker}`;
        if (selected) {
          line = paint(palette.heading, palette.selection, ` ${item.icon} ${padRight(item.label, SIDEBAR_WIDTH - 8)} ${isCurrent ? glyph.dot : ' '}`);
        } else if (isCurrent) {
          line = `${caret} ${fg(palette.text, label)} ${marker}`;
        } else {
          line = `${caret} ${dim(label)}`;
        }
        inner.push(line);
        flatIndex++;
      }
      inner.push('');
    }

    // Keep the selection in view.
    const innerHeight = height - 2;
    const selectedLine = this.sidebarLineOf(this.navIndex);
    if (selectedLine < this.navScroll) this.navScroll = selectedLine;
    if (selectedLine >= this.navScroll + innerHeight) this.navScroll = selectedLine - innerHeight + 1;
    const view = inner.slice(this.navScroll, this.navScroll + innerHeight);
    while (view.length < innerHeight) view.push('');

    void items;
    return panel(view, {
      width: SIDEBAR_WIDTH,
      title: 'Menu',
      color: this.focus === 'nav' ? palette.primary : palette.faint,
    });
  }

  /** Row within the sidebar inner list for a flat item index (accounts for
   *  group headings and spacers). */
  private sidebarLineOf(navIndex: number): number {
    let line = 0;
    let flat = 0;
    for (const group of MENU) {
      line++; // heading
      for (let i = 0; i < group.items.length; i++) {
        if (flat === navIndex) return line;
        line++;
        flat++;
      }
      line++; // spacer
    }
    return line;
  }

  private renderContent(height: number): string[] {
    const width = this.contentWidth();
    const innerWidth = width - 2;
    const innerHeight = height - 2;

    const body: string[] = [];
    body.push(fit(this.screen.status(), innerWidth));
    body.push('');

    let contentLines: string[];
    if (this.loading) {
      contentLines = [`  ${fg(palette.primary, spinnerFrames[this.spinnerFrame])} ${dim('Loading…')}`];
    } else {
      contentLines = this.screen.render(innerWidth, innerHeight);
    }
    this.lastContentHeight = contentLines.length;

    const viewHeight = innerHeight - 2;
    this.scroll = this.clampScroll(this.scroll);
    const slice = contentLines.slice(this.scroll, this.scroll + viewHeight);
    for (const line of slice) body.push(line);
    while (body.length < innerHeight) body.push('');

    const scrollBadge =
      contentLines.length > viewHeight
        ? `${this.scroll + 1}–${Math.min(contentLines.length, this.scroll + viewHeight)}/${contentLines.length}`
        : undefined;

    return panel(body, {
      width,
      title: this.screen.title,
      badge: scrollBadge,
      color: this.focus === 'content' ? palette.primary : palette.faint,
    });
  }

  private renderFooter(): string[] {
    const cols = this.size.cols;
    const hints = [
      ...this.screen.footer().map((h) => `${fg(palette.accent, h.key)} ${dim(h.label)}`),
      `${fg(palette.accent, '?')} ${dim('help')}`,
      `${fg(palette.accent, 'q')} ${dim('quit')}`,
    ];
    const hintLine = ' ' + hints.join(dim('   '));

    let toastLine = '';
    if (this.toastState) {
      const color =
        this.toastState.level === 'success'
          ? palette.primary
          : this.toastState.level === 'error'
            ? palette.red
            : this.toastState.level === 'warn'
              ? palette.amber
              : palette.accent;
      const icon =
        this.toastState.level === 'success'
          ? glyph.check
          : this.toastState.level === 'error'
            ? glyph.cross_mark
            : this.toastState.level === 'warn'
              ? glyph.warn
              : glyph.dot;
      toastLine = ` ${fg(color, icon)} ${fg(color, truncate(this.toastState.message, cols - 4))}`;
    } else {
      const ctx = this.source.getContext();
      toastLine = ` ${dim(`${ctx.demo ? 'demo mode · ' : ''}${this.focus === 'nav' ? 'browse the menu, then press enter' : 'esc returns to the menu'}`)}`;
    }
    return [fit(hintLine, cols), fit(toastLine, cols)];
  }

  private compositeOverlay(lines: string[]): void {
    const overlay = this.overlay!;
    const width = Math.min(overlay.width, this.size.cols - 4);
    const innerWidth = width - 2;
    const inner = overlay.render(innerWidth);
    const footer = overlay.footer ? ['', dim(overlay.footer)] : [];
    const boxed = panel([...inner, ...footer], {
      width,
      title: overlay.title,
      color: overlay.color ?? palette.accent,
    });
    const top = Math.max(1, Math.floor((this.size.rows - boxed.length) / 2));
    const left = Math.max(0, Math.floor((this.size.cols - width) / 2));
    const pad = ' '.repeat(left);
    for (let i = 0; i < boxed.length; i++) {
      const rowIndex = top + i;
      if (rowIndex >= 0 && rowIndex < lines.length) {
        lines[rowIndex] = pad + boxed[i];
      }
    }
  }
}

// ── small helpers ─────────────────────────────────────────────────

function row(keys: string, label: string): string {
  return `  ${fg(palette.accent, padRight(keys, 8))} ${dim(label)}`;
}

/** Split one input chunk into a single key's raw sequence and the rest. */
function takeKey(chunk: string): { raw: string; remainder: string } {
  if (chunk[0] === '\x1b') {
    // Match a CSI/SS3 sequence; otherwise treat ESC as a lone key.
    const m = chunk.match(/^\x1b(\[[0-9;?]*[A-Za-z~]|O[A-Za-z])/);
    if (m) return { raw: m[0], remainder: chunk.slice(m[0].length) };
    return { raw: '\x1b', remainder: chunk.slice(1) };
  }
  return { raw: chunk[0], remainder: chunk.slice(1) };
}

/** A reasonable default matchday when none is selected and one is needed. */
function currentGuess(): number {
  return 1;
}
