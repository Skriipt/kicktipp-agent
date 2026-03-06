#!/usr/bin/env node

import { Command } from 'commander';
import { getPredictors, choosePredictor } from './predictors/index.js';
import { loadCommunity, saveCommunity, loadPlayer, savePlayer, logout } from './config.js';
import { launchBrowser, getCommunities, getPlayers } from './browser.js';
import readline from 'readline';

const program = new Command();

const ask = (question: string): Promise<string> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
};

async function ensureCommunity(page: any): Promise<string> {
  let community = loadCommunity();
  if (!community) {
    await setCommunityInteractive(page);
    community = loadCommunity()!;
  }
  return community;
}

async function setCommunityInteractive(page: any): Promise<void> {
  const all = await getCommunities(page);
  if (!all.length) { console.error('No communities found.'); process.exit(1); }
  console.log('Available communities:');
  all.forEach((c, i) => console.log(`  [${i + 1}] ${c}`));
  const choice = await ask(`Select community (1-${all.length}): `);
  const idx = parseInt(choice) - 1;
  if (isNaN(idx) || idx < 0 || idx >= all.length) { console.error('Invalid selection.'); process.exit(1); }
  saveCommunity(all[idx]);
  console.log(`Saved '${all[idx]}' as default community.`);
}

async function setPlayerInteractive(page: any, community: string): Promise<void> {
  const players = await getPlayers(page, community);
  if (!players.length) { console.error('No players found.'); process.exit(1); }
  console.log('Players:');
  players.forEach((p, i) => console.log(`  [${i + 1}] ${p}`));
  const choice = await ask(`Which one are you? (1-${players.length}): `);
  const idx = parseInt(choice) - 1;
  if (isNaN(idx) || idx < 0 || idx >= players.length) { console.error('Invalid selection.'); process.exit(1); }
  savePlayer(players[idx]);
  console.log(`Saved '${players[idx]}' as your player.`);
}

program
  .name('kicktipp')
  .description('CLI tool for kicktipp.com')
  .version('1.0.0');

program
  .command('list-predictors')
  .description('Display a list of available predictors')
  .action(() => {
    Object.keys(getPredictors()).forEach((k) => console.log(k));
  });

program
  .command('logout')
  .description('Remove stored credentials and session')
  .action(() => logout());

program
  .command('list-communities')
  .description('Display a list of all communities')
  .action(async () => {
    const { browser, page } = await launchBrowser();
    const communities = await getCommunities(page);
    communities.forEach((c) => console.log(c));
    await browser.close();
  });

program
  .command('set-community')
  .description('Select a default community')
  .action(async () => {
    const { browser, page } = await launchBrowser();
    await setCommunityInteractive(page);
    await browser.close();
  });

program
  .command('list-players')
  .description('Display a list of all players in the saved community')
  .action(async () => {
    const { browser, page } = await launchBrowser();
    const community = await ensureCommunity(page);
    const players = await getPlayers(page, community);
    players.forEach((p) => console.log(p));
    await browser.close();
  });

program
  .command('set-player')
  .description('Select which player you are')
  .action(async () => {
    const { browser, page } = await launchBrowser();
    const community = await ensureCommunity(page);
    await setPlayerInteractive(page, community);
    await browser.close();
  });

// Commands from Task 6 and 7 will be added here via imports

export { program, ensureCommunity, ask };

program.parse();
