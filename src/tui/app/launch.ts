/**
 * Entry point for the dashboard.
 */
import { silenceStatus } from '../../helpers/spinner.js';
import { App } from './app.js';
import { LiveDataSource } from './live-source.js';

export interface LaunchOptions {
  matchday?: number | null;
  screen?: string;
}

export async function runTui(opts: LaunchOptions = {}): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error(
      'The dashboard needs an interactive terminal. Run `kicktipp tui` in a real terminal, or use the individual CLI commands.',
    );
  }
  const app = new App(new LiveDataSource(), {
    matchday: opts.matchday ?? null,
    screen: opts.screen,
  });
  silenceStatus(true);
  try {
    await app.run();
  } finally {
    silenceStatus(false);
  }
}
