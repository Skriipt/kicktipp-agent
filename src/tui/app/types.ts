/**
 * The contracts that let screens and overlays talk to the app without
 * importing it — keeping the module graph acyclic and each screen testable
 * against a stub app.
 */
import type { Rgb } from './ansi.js';
import type { Key } from './keys.js';
import type { DataSource } from './source.js';

export type ToastLevel = 'info' | 'success' | 'warn' | 'error';

export interface FooterHint {
  key: string;
  label: string;
}

export interface Screen {
  id: string;
  title: string;
  /** Screens that depend on the selected matchday get the prev/next controls. */
  matchdayScoped?: boolean;
  /** One-line context shown under the title. */
  status(): string;
  /** Fetch whatever the screen needs. Errors are caught by the app. */
  load(): Promise<void>;
  /** Inner content lines for the pane, sized to `width`. */
  render(width: number, height: number): string[];
  footer(): FooterHint[];
  /** Handle a key while the content pane is focused. Return true if handled. */
  onKey(key: Key): boolean | Promise<boolean>;
  /** When true, arrow keys go to the screen instead of scrolling the pane. */
  capturesInput?(): boolean;
}

export interface Overlay {
  title: string;
  /** Desired total width; the app clamps it to the terminal. */
  width: number;
  color?: Rgb;
  render(innerWidth: number): string[];
  footer?: string;
  onKey(key: Key): void | Promise<void>;
}

export interface AppApi {
  readonly source: DataSource;
  /** Selected matchday, or null for "current". */
  matchday: number | null;
  toast(message: string, level?: ToastLevel): void;
  openOverlay(overlay: Overlay): void;
  closeOverlay(): void;
  /** Reload the active screen's data. */
  reload(): Promise<void>;
  /** Navigate to a screen by id. */
  goto(id: string): Promise<void>;
  /** Change the matchday and reload if the screen is matchday-scoped. */
  setMatchday(matchday: number | null): Promise<void>;
  /** Re-read community/player/etc. after a change. */
  refreshContext(): void;
  /** Move keyboard focus back to the navigation sidebar. */
  focusSidebar(): void;
  requestRedraw(): void;
  quit(): void;
}
