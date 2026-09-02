import { Command } from 'commander';
import { runTui } from '../tui/app/launch.js';

/**
 * `kicktipp tui` — the full-screen dashboard. Every read, analytic and
 * betting action the CLI offers is reachable from one keyboard-driven
 * interface.
 */
export function registerTuiCommand(program: Command): void {
  program
    .command('tui')
    .alias('ui')
    .description('Open the full-screen dashboard for everything the CLI can do')
    .option('--matchday <n>', 'Start on a specific matchday (1-34)')
    .action(async (opts: { matchday?: string }) => {
      const parsed = opts.matchday ? Number.parseInt(opts.matchday, 10) : NaN;
      const matchday = Number.isInteger(parsed) && parsed >= 1 && parsed <= 34 ? parsed : null;
      await runTui({ matchday });
    });
}
