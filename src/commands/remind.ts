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
import { t } from '../i18n/index.js';

const SYSTEMD_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');

function installSystemd(everyMinutes: number, warnHours?: number): void {
  const units = systemdUnits({ everyMinutes, warnHours });
  fs.mkdirSync(SYSTEMD_DIR, { recursive: true });
  const service = path.join(SYSTEMD_DIR, 'kicktipp-deadline.service');
  const timer = path.join(SYSTEMD_DIR, 'kicktipp-deadline.timer');
  fs.writeFileSync(service, units.service);
  fs.writeFileSync(timer, units.timer);
  console.log(t('notify.wroteFile', { path: service }));
  console.log(t('notify.wroteFile', { path: timer }));
  console.log('\n' + t('notify.enableWith'));
  console.log('  systemctl --user daemon-reload');
  console.log('  systemctl --user enable --now kicktipp-deadline.timer');
}

function uninstallSystemd(): void {
  let removed = 0;
  for (const name of ['kicktipp-deadline.service', 'kicktipp-deadline.timer']) {
    const file = path.join(SYSTEMD_DIR, name);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(t('notify.removedFile', { path: file }));
      removed++;
    }
  }
  console.log(
    removed
      ? '\n' + t('notify.disableWith')
      : t('notify.nothingToRemove'),
  );
}

export function registerRemindCommand(program: Command): void {
  program
    .command('remind')
    .description(t('cmd.remind.description'))
    .option('--print <kind>', t('cmd.remind.optionPrint'))
    .option('--install', t('cmd.remind.optionInstall'))
    .option('--uninstall', t('cmd.remind.optionUninstall'))
    .option('--ics [file]', t('cmd.remind.optionIcs'))
    .option('--every <minutes>', t('cmd.remind.optionEvery'), parseInt)
    .option(
      '--warn-hours <n>',
      t('opt.warnHours'),
      parseFloat,
    )
    .option('--matchday <n>', t('opt.matchdayIcs'), parseInt)
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
        console.error(t('notify.unknownPrint', { kind: opts.print }));
        process.exit(1);
      }
      if (opts.uninstall) return uninstallSystemd();
      if (opts.install) return installSystemd(everyMinutes, opts.warnHours);

      if (opts.ics) {
        const { page } = await launchBrowser();
        try {
          const community = await ensureCommunity(page);
          status(t('status.loadingKickoffs'));
          const { matches } = await fetchBets(page, community, opts.matchday);
          statusClear();
          const report = buildDeadlineReport(community, opts.matchday ?? null, matches, {
            warnHours: opts.warnHours,
          });
          const calendar = icsCalendar(report);
          const file = typeof opts.ics === 'string' ? opts.ics : 'kicktipp-deadlines.ics';
          fs.writeFileSync(file, calendar);
          console.log(t('notify.wroteIcs', { file, n: report.matches.filter((m) => !m.closed).length }));
        } finally {
          await page.close();
        }
        return;
      }

      console.error(t('notify.nothingToDo'));
      process.exit(1);
    });
}

export function registerNotifyCommand(program: Command): void {
  program
    .command('notify')
    .description(t('cmd.notify.description'))
    .option('--matchday <n>', t('opt.matchday'), parseInt)
    .option(
      '--warn-hours <n>',
      t('opt.warnHours'),
      parseFloat,
    )
    .option('--force', t('cmd.notify.optionForce'))
    .option('--json', t('cmd.notify.optionJson'))
    .action(async (opts) => {
      if (opts.json) setJsonMode(true);
      const { page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        status(t('status.checkingDeadlines'));
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
          console.log(t('notify.nothingUrgent'));
          return;
        }

        await notify(readNotifierConfig(), summary, report);
        console.log(t('notify.sent'));
      } finally {
        await page.close();
      }
    });
}

function kindHelp(): { kind: 'desktop' | 'webhook' | 'command'; label: string }[] {
  return [
    { kind: 'desktop', label: t('notify.labelDesktop') },
    { kind: 'webhook', label: t('notify.labelWebhook') },
    { kind: 'command', label: t('notify.labelCommand') },
  ];
}

async function resolveNotifierArgs(kindArg?: string, targetArg?: string): Promise<{ kind: string; target?: string }> {
  let kind = kindArg?.trim().toLowerCase();
  let target = targetArg?.trim() || undefined;

  if (!kind) {
    if (!process.stdin.isTTY) {
      throw new Error(t('notify.passKind'));
    }
    const backends = kindHelp();
    console.log(t('notify.backends'));
    backends.forEach((entry, i) => console.log(`  [${i + 1}] ${entry.kind.padEnd(8)}  ${entry.label}`));
    const choice = await ask(t('notify.selectBackend', { n: backends.length }));
    const idx = parseInt(choice, 10) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= backends.length) {
      throw new Error(t('common.invalidSelection'));
    }
    kind = backends[idx].kind;
  }

  if ((kind === 'webhook' || kind === 'command') && !target) {
    if (!process.stdin.isTTY) {
      parseNotifierSettings(kind, target);
    }
    target = (await ask(kind === 'webhook' ? t('notify.webhookUrl') : t('notify.commandPath'))).trim();
  }

  return { kind, target };
}

export function registerSetNotifyCommand(program: Command): void {
  program
    .command('set-notify')
    .description(t('cmd.setNotify.description'))
    .argument('[kind]', t('cmd.setNotify.argumentKind'))
    .argument('[target]', t('cmd.setNotify.argumentTarget'))
    .action(async (kindArg: string | undefined, targetArg: string | undefined) => {
      const { kind, target } = await resolveNotifierArgs(kindArg, targetArg);
      const saved = applyNotifierSettings(kind, target);
      if (saved.kind === 'desktop') console.log(t('notify.savedDesktop'));
      else console.log(t('notify.savedOther', { kind: saved.kind, target: saved.target ?? '' }));
    });
}
