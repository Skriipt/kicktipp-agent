/**
 * Entry point for the dashboard. Picks a data source (live or demo) and hands
 * control to the app until the user quits.
 */
import { App } from './app.js';
import { LiveDataSource } from './live-source.js';
import { DemoDataSource } from './demo-source.js';
import type { DataSource } from './source.js';

export interface LaunchOptions {
  demo?: boolean;
  matchday?: number | null;
}

export async function runTui(opts: LaunchOptions = {}): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error(
      'The dashboard needs an interactive terminal. Run `kicktipp tui` in a real terminal, or use the individual CLI commands.',
    );
  }
  const source: DataSource = opts.demo ? new DemoDataSource() : new LiveDataSource();
  const app = new App(source, { matchday: opts.matchday ?? null });
  await app.run();
}
