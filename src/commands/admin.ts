import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { emitJson, setJsonMode, widest } from '../helpers/output.js';
import { assertWritable } from '../read-only.js';
import {
  fetchMembers,
  fetchBetsForMember,
  placeBetsForMember,
  resolveMember,
} from '../core.js';
import { t } from '../i18n/index.js';

export function registerAdminCommand(program: Command): void {
  const admin = program
    .command('admin')
    .description(t('cmd.admin.description'));

  admin
    .command('members')
    .description(t('cmd.admin.members'))
    .option('--json', t('opt.json'))
    .action(async (opts) => {
      if (opts.json) setJsonMode(true);
      const page = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        status(t('status.loadingMembers'));
        const members = await fetchMembers(page, community);
        statusClear();

        if (opts.json) {
          emitJson({ community, data: members });
          return;
        }
        if (!members.length) {
          console.log(t('admin.noMembers'));
          return;
        }
        const nameWidth = widest(members.map((m) => m.name), 4);
        for (const member of members) {
          console.log(
            `  ${member.name.padEnd(nameWidth)}  ${member.tipperId.padStart(10)}` +
              (member.dummy ? `  ${t('common.dummy')}` : ''),
          );
        }
      } finally {
        await page.close();
      }
    });

  admin
    .command('bets')
    .description(t('cmd.admin.bets'))
    .argument('<member>', t('cmd.admin.argumentMember'))
    .option('--matchday <n>', t('opt.matchday'), parseInt)
    .option('--json', t('opt.json'))
    .action(async (reference: string, opts) => {
      if (opts.json) setJsonMode(true);
      const page = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        status(t('status.loadingMembers'));
        const member = resolveMember(await fetchMembers(page, community), reference);
        const data = await fetchBetsForMember(page, community, member, opts.matchday);
        statusClear();

        if (opts.json) {
          emitJson({ community, matchday: opts.matchday ?? null, data });
          return;
        }
        console.log(`${t('admin.betsFor', { name: member.name, id: member.tipperId })}\n`);
        const width = widest(data.matches.map((m) => `${m.home} vs ${m.away}`));
        for (const match of data.matches) {
          console.log(`  ${`${match.home} vs ${match.away}`.padEnd(width)}  ${match.bet}`);
        }
      } finally {
        await page.close();
      }
    });

  admin
    .command('bet')
    .description(t('cmd.admin.place'))
    .argument('<member>', t('cmd.admin.argumentMember'))
    .argument('<bets...>', t('cmd.admin.argumentBets'))
    .option('--matchday <n>', t('opt.matchday'), parseInt)
    .option('--dry-run', t('opt.dryRun'))
    .option('--yes', t('opt.yes'))
    .action(async (reference: string, bets: string[], opts) => {
      if (!opts.dryRun) assertWritable('Placing bets for another member');
      const page = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        status(t('status.loadingMembers'));
        const member = resolveMember(await fetchMembers(page, community), reference);
        statusClear();

        console.log(
          `${t('admin.aboutToPlace', { name: member.name })} (${member.tipperId})`,
        );
        for (const bet of bets) console.log(`  ${bet}`);

        if (!opts.dryRun && !opts.yes) {
          const { ask } = await import('../shared.js');
          const answer = (await ask(t('admin.confirmName'))).trim();
          if (answer.toLowerCase() !== member.name.toLowerCase()) {
            console.log(t('admin.nameMismatch'));
            return;
          }
        }

        const placed = await placeBetsForMember(
          page,
          community,
          member,
          bets,
          opts.matchday,
          !opts.dryRun,
          'cli:admin',
        );
        console.log(
          opts.dryRun
            ? t('admin.wouldPlace', { n: placed.length, name: member.name })
            : t('admin.placed', { n: placed.length, name: member.name }),
        );
      } finally {
        await page.close();
      }
    });
}
