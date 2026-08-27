#!/usr/bin/env node

import { Command } from 'commander';
import { saveCommunity, savePlayer, logout } from './config.js';
import { launchBrowser, getCommunities, getPlayers } from './browser.js';
import { ask, ensureCommunity } from './shared.js';
import { registerLeaderboardCommand } from './commands/leaderboard.js';
import { registerOverviewCommand } from './commands/overview.js';
import { registerScheduleCommand } from './commands/schedule.js';
import { registerTableCommand } from './commands/table.js';
import { registerBetsCommand } from './commands/bets.js';
import { registerRulesCommand } from './commands/rules.js';
import { registerBetCommand } from './commands/bet.js';
import { registerTodayCommand } from './commands/today.js';
import { registerGuideCommand } from './commands/guide.js';
import { registerTipStatusCommand } from './commands/tip-status.js';

const program = new Command();

async function setCommunityInteractive(page: any): Promise<void> {
  const all = await getCommunities(page);
  if (!all.length) {
    console.error('No communities found.');
    process.exit(1);
  }
  console.log('Available communities:');
  all.forEach((community, index) =>
    console.log(`  [${index + 1}] ${community}`),
  );
  const choice = await ask(`Select community (1-${all.length}): `);
  const index = parseInt(choice) - 1;
  if (isNaN(index) || index < 0 || index >= all.length) {
    console.error('Invalid selection.');
    process.exit(1);
  }
  saveCommunity(all[index]);
  console.log(`Saved '${all[index]}' as default community.`);
}

async function setPlayerInteractive(
  page: any,
  community: string,
): Promise<void> {
  const players = await getPlayers(page, community);
  if (!players.length) {
    console.error('No players found.');
    process.exit(1);
  }
  console.log('Players:');
  players.forEach((player, index) =>
    console.log(`  [${index + 1}] ${player}`),
  );
  const choice = await ask(`Which one are you? (1-${players.length}): `);
  const index = parseInt(choice) - 1;
  if (isNaN(index) || index < 0 || index >= players.length) {
    console.error('Invalid selection.');
    process.exit(1);
  }
  savePlayer(players[index]);
  console.log(`Saved '${players[index]}' as your player.`);
}

program
  .name('kicktipp')
  .description('CLI tool for Kicktipp')
  .version('1.1.0');

program
  .command('logout')
  .description('Remove stored credentials and session')
  .action(() => logout());

program
  .command('communities')
  .description('List all communities you belong to')
  .action(async () => {
    const { browser, page } = await launchBrowser();
    const communities = await getCommunities(page);
    communities.forEach((community) => console.log(community));
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
  .command('players')
  .description('List players in the saved community')
  .action(async () => {
    const { browser, page } = await launchBrowser();
    const community = await ensureCommunity(page);
    const players = await getPlayers(page, community);
    players.forEach((player) => console.log(player));
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

registerLeaderboardCommand(program);
registerOverviewCommand(program);
registerScheduleCommand(program);
registerTableCommand(program);
registerBetsCommand(program);
registerRulesCommand(program);
registerBetCommand(program);
registerTodayCommand(program);
registerTipStatusCommand(program);
registerGuideCommand(program);

export { program, ensureCommunity, ask };

program.parse();
