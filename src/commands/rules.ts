import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { emitJson, setJsonMode, widest } from '../helpers/output.js';
import { fetchRules, fetchLeaderboard, fetchMatchdayBets, type RulesSection } from '../core.js';
import { CacheStore } from '../cache/store.js';
import { resolveRules } from '../rules/resolve.js';
import { verifyRules } from '../rules/verify.js';
import { t } from '../i18n/index.js';

function render(sections: RulesSection[]): string {
  if (!sections.length) return t('common.noRules');

  const lines: string[] = [];
  for (const section of sections) {
    if (section.type === 'heading') {
      lines.push('', section.text ?? '', '='.repeat((section.text ?? '').length));
    } else if (section.type === 'paragraph') {
      if (section.text) lines.push(section.text, '');
    } else if (section.type === 'table' && section.headers) {
      const columns = section.headers.length;
      const widths = section.headers.map((h, i) =>
        widest([h, ...(section.rows ?? []).map((r) => r[i] ?? '')]),
      );
      lines.push(
        '  ' + section.headers.map((h, i) => h.padEnd(widths[i])).join('  '),
      );
      lines.push('  ' + widths.map((w) => '-'.repeat(w)).join('  '));
      for (const row of section.rows ?? []) {
        lines.push(
          '  ' +
            Array.from({ length: columns }, (_, i) => (row[i] ?? '').padEnd(widths[i])).join('  '),
        );
      }
      lines.push('');
    }
  }
  return lines.join('\n').trim();
}

function renderVerification(
  values: { exact: number; goalDiff: number; tendency: number },
  result: ReturnType<typeof verifyRules>,
): string {
  const lines = [
    `Checking ${values.exact}/${values.goalDiff}/${values.tendency} ` +
      `(exact/difference/tendency) against matchday ${result.matchday ?? 'current'}`,
    '',
  ];

  if (result.reason) {
    lines.push(`Could not check: ${result.reason}`);
    return lines.join('\n');
  }

  for (const player of result.players) {
    const mark = player.reported === null ? '?' : player.agrees ? 'ok' : 'MISMATCH';
    const reported = player.reported === null ? 'not on leaderboard' : String(player.reported);
    lines.push(
      `  ${player.player.padEnd(20)} computed ${String(player.computed).padStart(3)}  ` +
        `reported ${reported.padStart(3)}  ${mark}`,
    );
  }

  lines.push('');
  lines.push(
    result.verified
      ? `Verified: the model reproduces all ${result.checked} reported scores.`
      : `${result.checked - result.agreed} of ${result.checked} players do not match — ` +
        'the point values are probably wrong. Set them explicitly under [scoring] in config.ini.',
  );
  return lines.join('\n');
}

export function registerRulesCommand(program: Command): void {
  program
    .command('rules')
    .description(t('cmd.rules.description'))
    .option('--verify [matchday]', t('cmd.rules.optionVerify'))
    .option('--json', t('opt.json'))
    .action(async (opts) => {
      if (opts.json) setJsonMode(true);
      const page = await launchBrowser();
      try {
        const community = await ensureCommunity(page);

        if (opts.verify) {
          const cache = { store: new CacheStore(community) };
          const matchday = typeof opts.verify === 'string' ? parseInt(opts.verify, 10) : undefined;
          status(t('status.verifyingRules'));
          const rules = await resolveRules(page, community, cache);
          const grid = await fetchMatchdayBets(page, community, matchday, cache);
          const leaderboard = await fetchLeaderboard(page, community, matchday, false, cache);
          statusClear();

          const result = verifyRules(grid, leaderboard, rules.values);
          if (opts.json) {
            emitJson({ community, rules, verification: result });
          } else {
            console.log(renderVerification(rules.values, result));
          }
          if (!result.verified) process.exitCode = 1;
          return;
        }

        status(t('status.loadingRules'));
        const data = await fetchRules(page, community);
        statusClear();

        if (opts.json) emitJson({ community, data });
        else console.log(render(data));
      } finally {
        await page.close();
      }
    });
}
