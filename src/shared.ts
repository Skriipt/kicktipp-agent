import readline from 'readline';
import { Page } from './browser.js';
import { loadCommunity, saveCommunity } from './config.js';
import { getCommunities } from './browser.js';
import { t } from './i18n/index.js';

export const ask = (question: string): Promise<string> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
};

export async function ensureCommunity(page: Page): Promise<string> {
  let community = loadCommunity();
  if (!community) {
    const all = await getCommunities(page);
    if (!all.length) { console.error(t('common.noCommunities')); process.exit(1); }
    console.log(t('common.availableCommunities'));
    all.forEach((c, i) => console.log(`  [${i + 1}] ${c}`));
    const choice = await ask(t('common.selectCommunity', { n: all.length }));
    const idx = parseInt(choice) - 1;
    if (isNaN(idx) || idx < 0 || idx >= all.length) { console.error(t('common.invalidSelection')); process.exit(1); }
    saveCommunity(all[idx]);
    console.log(t('common.savedCommunity', { name: all[idx] }));
    community = all[idx];
  }
  return community;
}
