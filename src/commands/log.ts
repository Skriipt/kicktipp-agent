import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { loadCommunity } from '../config.js';
import { ask } from '../shared.js';
import { emitJson, setJsonMode } from '../helpers/output.js';
import { readAudit, lastSubmission, auditFile, type AuditRecord } from '../audit/log.js';
import { placeBets } from '../core.js';
import { assertWritable } from '../read-only.js';
import { t } from '../i18n/index.js';

function requireCommunity(): string {
  const community = loadCommunity();
  if (!community) {
    console.error(t('common.noCommunity'));
    process.exit(1);
  }
  return community;
}

function render(records: AuditRecord[], community: string): string {
  if (!records.length) {
    return `No bets recorded for ${community} yet.\n(${auditFile(community)})`;
  }

  const lines = [`Bet log for ${community}`, ''];
  for (const record of records) {
    const when = new Date(record.at).toLocaleString();
    const md = record.matchday ? ` MD${record.matchday}` : '';
    lines.push(`${when}  ${record.outcome.padEnd(10)} ${record.source}${md}`);
    for (const bet of record.bets) {
      const from = bet.previous ? ` (was ${bet.previous})` : '';
      lines.push(`    ${bet.fixture} = ${bet.bet}${from}`);
    }
  }
  return lines.join('\n');
}

export function registerLogCommand(program: Command): void {
  program
    .command('log')
    .description(t('cmd.log.description'))
    .option('--matchday <n>', t('opt.matchdayOnly'), parseInt)
    .option('--all', t('cmd.log.optionAll'))
    .option('--undo', t('cmd.log.optionUndo'))
    .option('--yes', t('opt.yes'))
    .option('--json', t('opt.json'))
    .action(async (opts) => {
      if (opts.json) setJsonMode(true);
      const community = requireCommunity();

      if (opts.undo) {
        assertWritable('Undoing bets');
        const last = lastSubmission(community, opts.matchday);
        if (!last) {
          console.error(t('log.nothingUndo'));
          process.exit(1);
        }
        const restorable = last.bets.filter((b) => b.previous);
        if (!restorable.length) {
          console.error(
            'Nothing to undo: the last submission did not replace any existing bets.',
          );
          process.exit(1);
        }

        console.log(t('log.undoing', { when: new Date(last.at).toLocaleString() }));
        for (const bet of restorable) {
          console.log(`  ${bet.fixture}: ${bet.bet} -> ${bet.previous}`);
        }

        if (!opts.yes) {
          const answer = (await ask(t('log.confirm'))).trim().toLowerCase();
          if (answer !== 'y' && answer !== 'yes' && answer !== 'j' && answer !== 'ja') {
            console.log(t('common.nothingSubmitted'));
            return;
          }
        }

        const { page } = await launchBrowser();
        try {
          const args = restorable.map((b) => `${b.fixture}=${b.previous}`);
          const placed = await placeBets(page, community, args, last.matchday ?? undefined, true, 'cli:bet');
          console.log(t('log.restored', { n: placed.length }));
        } finally {
          await page.close();
        }
        return;
      }

      let records = readAudit(community);
      if (!opts.all) records = records.filter((r) => r.outcome === 'submitted');
      if (opts.matchday !== undefined) {
        records = records.filter((r) => r.matchday === opts.matchday);
      }

      if (opts.json) emitJson({ community, file: auditFile(community), records });
      else console.log(render(records, community));
    });
}
