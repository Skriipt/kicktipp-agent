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

export function registerAdminCommand(program: Command): void {
  const admin = program
    .command('admin')
    .description('Spielleiter tools: act on behalf of another member (admin rights required)');

  admin
    .command('members')
    .description('List the community members with their tipperIds')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      if (opts.json) setJsonMode(true);
      const { page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        status('Loading members...');
        const members = await fetchMembers(page, community);
        statusClear();

        if (opts.json) {
          emitJson({ community, data: members });
          return;
        }
        if (!members.length) {
          console.log('No members found. Are you a Spielleiter of this community?');
          return;
        }
        const nameWidth = widest(members.map((m) => m.name), 4);
        for (const member of members) {
          console.log(
            `  ${member.name.padEnd(nameWidth)}  ${member.tipperId.padStart(10)}` +
              (member.dummy ? '  (dummy)' : ''),
          );
        }
      } finally {
        await page.close();
      }
    });

  admin
    .command('bets')
    .description("Show another member's bets for a matchday")
    .argument('<member>', 'Member name or tipperId')
    .option('--matchday <n>', 'Matchday number (1-34)', parseInt)
    .option('--json', 'Output raw JSON')
    .action(async (reference: string, opts) => {
      if (opts.json) setJsonMode(true);
      const { page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        status('Loading members...');
        const member = resolveMember(await fetchMembers(page, community), reference);
        const data = await fetchBetsForMember(page, community, member, opts.matchday);
        statusClear();

        if (opts.json) {
          emitJson({ community, matchday: opts.matchday ?? null, data });
          return;
        }
        console.log(`Bets for ${member.name} (${member.tipperId})\n`);
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
    .description('Place bets on behalf of another member')
    .argument('<member>', 'Member name or tipperId')
    .argument('<bets...>', 'Bets as "Home vs Away=H:G"')
    .option('--matchday <n>', 'Matchday number (1-34)', parseInt)
    .option('--dry-run', 'Show what would be submitted without submitting')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (reference: string, bets: string[], opts) => {
      if (!opts.dryRun) assertWritable('Placing bets for another member');
      const { page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        status('Loading members...');
        const member = resolveMember(await fetchMembers(page, community), reference);
        statusClear();

        console.log(
          `About to place ${bets.length} bet(s) on behalf of ${member.name} ` +
            `(${member.tipperId})${member.dummy ? ', a dummy member' : ''}.`,
        );
        for (const bet of bets) console.log(`  ${bet}`);

        if (!opts.dryRun && !opts.yes) {
          const { ask } = await import('../shared.js');
          const answer = (await ask(`Type the member's name to confirm: `)).trim();
          if (answer.toLowerCase() !== member.name.toLowerCase()) {
            console.log('Name did not match. Nothing submitted.');
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
            ? `Dry run: ${placed.length} bet(s) would be placed for ${member.name}.`
            : `Placed ${placed.length} bet(s) for ${member.name}.`,
        );
      } finally {
        await page.close();
      }
    });
}
