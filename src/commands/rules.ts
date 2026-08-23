import { Command } from 'commander';
import { launchBrowser } from '../browser.js';
import { ensureCommunity } from '../shared.js';
import { status, statusClear } from '../helpers/spinner.js';
import { emitJson, setJsonMode, widest } from '../helpers/output.js';
import { fetchRules, type RulesSection } from '../core.js';

function render(sections: RulesSection[]): string {
  if (!sections.length) return 'No rules found.';

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

export function registerRulesCommand(program: Command): void {
  program
    .command('rules')
    .description('Display the game rules')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      if (opts.json) setJsonMode(true);
      const { page } = await launchBrowser();
      try {
        const community = await ensureCommunity(page);
        status('Loading rules...');
        const data = await fetchRules(page, community);
        statusClear();

        if (opts.json) emitJson({ community, data });
        else console.log(render(data));
      } finally {
        await page.close();
      }
    });
}
