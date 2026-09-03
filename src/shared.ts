import readline from 'readline';
import { Page } from './browser.js';
import { loadCommunity, saveCommunity } from './config.js';
import { getCommunities } from './browser.js';
import { t } from './i18n/index.js';

export const ask = (question: string): Promise<string> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
};

export function requireCommunity(): string {
  const community = loadCommunity();
  if (community) return community;
  console.error(t('common.noCommunity'));
  process.exit(1);
}

export async function selectCommunity(page: Page): Promise<string> {
  const all = await getCommunities(page);
  if (!all.length) { console.error(t('common.noCommunities')); process.exit(1); }
  console.log(t('common.availableCommunities'));
  all.forEach((community, i) => console.log(`  [${i + 1}] ${community}`));
  const index = parseInt(await ask(t('common.selectCommunity', { n: all.length }))) - 1;
  if (isNaN(index) || index < 0 || index >= all.length) {
    console.error(t('common.invalidSelection'));
    process.exit(1);
  }
  saveCommunity(all[index]);
  console.log(t('common.savedCommunity', { name: all[index] }));
  return all[index];
}

export async function ensureCommunity(page: Page): Promise<string> {
  return loadCommunity() ?? selectCommunity(page);
}
