import { Command } from 'commander';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { emitJson, setJsonMode } from '../helpers/output.js';
import { fetchBets } from '../core.js';
import { buildDeadlineReport, urgencyWarning } from '../analytics/deadline.js';
import { cronLine, icsCalendar, systemdUnits } from '../notify/schedule-artifacts.js';
import {
  applyNotifierSettings,
  notify,
  parseNotifierSettings,
  readNotifierConfig,
} from '../notify/backends.js';
import { ask } from '../shared.js';

const SYSTEMD_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');

function installSystemd(everyMinutes: number, warnHours?: number): void {
  const units = systemdUnits({ everyMinutes, warnHours });
  fs.mkdirSync(SYSTEMD_DIR, { recursive: true });
  const service = path.join(SYSTEMD_DIR, 'kicktipp-deadline.service');
  const timer = path.join(SYSTEMD_DIR, 'kicktipp-deadline.timer');
  fs.writeFileSync(service, units.service);
  fs.writeFileSync(timer, units.timer);
  console.log(`Wrote ${service}`);
  console.log(`Wrote ${timer}`);
  console.log('\nEnable it with:');
  console.log('  systemctl --user daemon-reload');
  console.log('  systemctl --user enable --now kicktipp-deadline.timer');
}

function uninstallSystemd(): void {
  let removed = 0;
  for (const name of ['kicktipp-deadline.service', 'kicktipp-deadline.timer']) {
    const file = path.join(SYSTEMD_DIR, name);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(`Removed ${file}`);
      removed++;
    }
  }
  console.log(
    removed
      ? '\nDisable it with:\n  systemctl --user disable --now kicktipp-deadline.timer'
      : 'Nothing to remove.',
  );
}

export function registerRemindCommand(program: Command): void {
  program
    .command('remind')
    .description('Generate a schedule or calendar file that reminds you before kickoff')
    .option('--print <kind>', 'Print a cron line or systemd units: cron | systemd')
    .option('--install', 'Write the systemd user units (does not enable them)')
    .option('--uninstall', 'Remove the systemd user units')
    .option('--ics [file]', 'Write a calendar file with an alarm per kickoff')
    .option('--every <minutes>', 'How often to check', parseInt)
    .option(
      '--warn-hours <n>',
      'Hours before kickoff that an unbetted match counts as urgent (default: 6)',
      parseFloat,
    )
    .option('--matchday <n>', 'Matchday for --ics', parseInt)
    .action(async (opts) => {
      const everyMinutes = opts.every ?? 60;

      if (opts.print === 'cron') {
        console.log(cronLine({ everyMinutes, warnHours: opts.warnHours }));
        return;
      }
      if (opts.print === 'systemd') {
        const units = systemdUnits({ everyMinutes, warnHours: opts.warnHours });
        console.log(`# ${path.join(SYSTEMD_DIR, 'kicktipp-deadline.service')}`);
        console.log(units.service);
        console.log(`# ${path.join(SYSTEMD_DIR, 'kicktipp-deadline.timer')}`);
        console.log(units.timer);
        return;
      }
      if (opts.print) {
        console.error(`Unknown --print kind '${opts.print}'. Use cron or systemd.`);
        process.exit(1);
      }
      if (opts.uninstall) return uninstallSystemd();
      if (opts.install) return installSystemd(everyMinutes, opts.warnHours);

      if (opts.ics) {
        const { page } = await launchBrowser();
        try {
          const community = await ensureCommunity(page);
          status('Loading kickoffs...');
          const { matches } = await fetchBets(page, community, opts.matchday);
          statusClear();
          const report = buildDeadlineReport(community, opts.matchday ?? null, matches, {
            warnHours: opts.warnHours,
          });
          const calendar = icsCalendar(report);
          const file = typeof opts.ics === 'string' ? opts.ics : 'kicktipp-deadlines.ics';
          fs.writeFileSync(file, calendar);
          console.log(`Wrote ${file} (${report.matches.filter((m) => !m.closed).length} event(s)).`);
        } finally {
          await page.close();
        }
        return;
      }

      console.error('Nothing to do. Use --print cron|systemd, --install, --uninstall or --ics.');
      process.exit(1);
    });
}

export function registerNotifyCommand(program: Command): void {
  program
    .command('notify')
    .description('Send a reminder through the configured notifier, if anything needs a bet')
    .option('--matchday <n>', 'Matchday number (1-34)', parseInt)
    .option(
      '--warn-hours <n>',
      'Hours before kickoff that an unbetted match counts as urgent (default: 6)',
      parseFloat,
    )
    .option('--force', 'Notify even when nothing is urgent')
    .option('--json', 'Output raw JSON instead of notifying')
    .action(async (opts) => {
      if (opts.json) setJsonMode(true);
      const { page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        status('Checking deadlines...');
        const { matches } = await fetchBets(page, community, opts.matchday);
        statusClear();

        const report = buildDeadlineReport(community, opts.matchday ?? null, matches, {
          warnHours: opts.warnHours,
        });
        const summary =
          urgencyWarning(report) ??
          `${report.needsBetCount} match(es) still need a bet in ${community}.`;

        if (opts.json) {
          emitJson({ summary, ...report });
          return;
        }
        if (!report.urgentCount && !opts.force) {
          console.log('Nothing urgent; no notification sent.');
          return;
        }

        await notify(readNotifierConfig(), summary, report);
        console.log('Notification sent.');
      } finally {
        await page.close();
      }
    });
}

const KIND_HELP = [
  { kind: 'desktop' as const, label: 'macOS Notification Center / notify-send' },
  { kind: 'webhook' as const, label: 'POST JSON to a URL (ntfy, Slack, Home Assistant)' },
  { kind: 'command' as const, label: 'Run a local program' },
];

async function resolveNotifierArgs(kindArg?: string, targetArg?: string): Promise<{ kind: string; target?: string }> {
  let kind = kindArg?.trim().toLowerCase();
  let target = targetArg?.trim() || undefined;

  if (!kind) {
    if (!process.stdin.isTTY) {
      throw new Error('Pass a kind: kicktipp set-notify desktop|webhook|command [target]');
    }
    console.log('Notifier backends:');
    KIND_HELP.forEach((entry, i) => console.log(`  [${i + 1}] ${entry.kind.padEnd(8)}  ${entry.label}`));
    const choice = await ask(`Select backend (1-${KIND_HELP.length}): `);
    const idx = parseInt(choice, 10) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= KIND_HELP.length) {
      throw new Error('Invalid selection.');
    }
    kind = KIND_HELP[idx].kind;
  }

  if ((kind === 'webhook' || kind === 'command') && !target) {
    if (!process.stdin.isTTY) {
      parseNotifierSettings(kind, target);
    }
    target = (await ask(kind === 'webhook' ? 'Webhook URL: ' : 'Command path: ')).trim();
  }

  return { kind, target };
}

export function registerSetNotifyCommand(program: Command): void {
  program
    .command('set-notify')
    .description('Configure how `notify` delivers reminders (desktop, webhook, or command)')
    .argument('[kind]', 'desktop | webhook | command')
    .argument('[target]', 'Webhook URL or executable path')
    .action(async (kindArg: string | undefined, targetArg: string | undefined) => {
      const { kind, target } = await resolveNotifierArgs(kindArg, targetArg);
      const saved = applyNotifierSettings(kind, target);
      if (saved.kind === 'desktop') console.log('Saved desktop notifier.');
      else console.log(`Saved ${saved.kind} notifier → ${saved.target}`);
    });
}
