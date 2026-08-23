#!/usr/bin/env node

import { Command } from 'commander';
import {
  saveCommunity,
  savePlayer,
  logout,
  listProfiles,
  setActiveProfile,
  setCommunityOverride,
  getActiveProfile,
} from './config.js';
import { launchBrowser, getCommunities, getPlayers } from './browser.js';
import { ask, ensureCommunity } from './shared.js';
import { statusClear } from './helpers/spinner.js';
import { emitError, emitJson, setJsonMode } from './helpers/output.js';
import { registerLeaderboardCommand } from './commands/leaderboard.js';
import { registerOverviewCommand } from './commands/overview.js';
import { registerScheduleCommand } from './commands/schedule.js';
import { registerTableCommand } from './commands/table.js';
import { registerBetsCommand } from './commands/bets.js';
import { registerRulesCommand } from './commands/rules.js';
import { registerBetCommand } from './commands/bet.js';
import { registerTodayCommand } from './commands/today.js';
import { registerGuideCommand } from './commands/guide.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerCacheCommand } from './commands/cache.js';
import { registerStatsCommand } from './commands/stats.js';
import { registerRivalCommand } from './commands/rival.js';
import { registerSuggestCommand } from './commands/suggest.js';
import { registerDeadlineCommand } from './commands/deadline.js';
import { registerNotifyCommand, registerRemindCommand } from './commands/remind.js';
import { registerLogCommand } from './commands/log.js';
import { registerScenarioCommand } from './commands/scenario.js';
import { registerWhatifCommand } from './commands/whatif.js';

const program = new Command();

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
  .version('1.0.0')
  .option('-c, --community <slug>', 'Act on this community instead of the saved default')
  .option('-p, --profile <name>', 'Use this config profile (a separate account and session)')
  .hook('preAction', (command) => {
    // Applied before every subcommand so the flags work everywhere without
    // each command having to know about them.
    const opts = command.opts();
    if (opts.profile) setActiveProfile(opts.profile);
    if (opts.community) setCommunityOverride(opts.community);
  });

program
  .command('profiles')
  .description('List the configured profiles')
  .option('--json', 'Output raw JSON')
  .action((opts) => {
    const profiles = listProfiles();
    const active = getActiveProfile();
    if (opts.json) {
      emitJson({ active, profiles });
      return;
    }
    if (!profiles.length) {
      console.log('No profiles configured. The default [auth]/[community]/[player] sections are in use.');
      console.log('Add one as a [profile.<name>] section in ~/.config/kicktipp-agent/config.ini.');
      return;
    }
    for (const name of profiles) {
      console.log(`${name === active ? '*' : ' '} ${name}`);
    }
  });

program
  .command('logout')
  .description('Remove stored credentials and session')
  .action(() => logout());

program
  .command('communities')
  .description('List all communities you belong to')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    if (opts.json) setJsonMode(true);
    const { page } = await launchBrowser();
    try {
      const communities = await getCommunities(page);
      if (opts.json) emitJson({ data: communities });
      else communities.forEach((c) => console.log(c));
    } finally {
      await page.close();
    }
  });

program
  .command('set-community')
  .description('Select a default community')
  .action(async () => {
    const { page } = await launchBrowser();
    await setCommunityInteractive(page);
    await page.close();
  });

program
  .command('players')
  .description('List players in the saved community')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    if (opts.json) setJsonMode(true);
    const { page } = await launchBrowser();
    try {
      const community = await ensureCommunity(page);
      const players = await getPlayers(page, community);
      if (opts.json) emitJson({ community, data: players });
      else players.forEach((p) => console.log(p));
    } finally {
      await page.close();
    }
  });

program
  .command('set-player')
  .description('Select which player you are')
  .action(async () => {
    const { page } = await launchBrowser();
    const community = await ensureCommunity(page);
    await setPlayerInteractive(page, community);
    await page.close();
  });

registerLeaderboardCommand(program);
registerOverviewCommand(program);
registerScheduleCommand(program);
registerTableCommand(program);
registerBetsCommand(program);
registerRulesCommand(program);
registerBetCommand(program);
registerTodayCommand(program);
registerGuideCommand(program);
registerSyncCommand(program);
registerCacheCommand(program);
registerStatsCommand(program);
registerRivalCommand(program);
registerSuggestCommand(program);
registerDeadlineCommand(program);
registerRemindCommand(program);
registerNotifyCommand(program);
registerLogCommand(program);
registerScenarioCommand(program);
registerWhatifCommand(program);

export { program, ensureCommunity, ask };

// Errors from the Kicktipp layer (failed login, expired session, unknown
// community) are reported as plain messages rather than stack traces.
program.parseAsync().catch((err) => {
  statusClear();
  // In --json mode the failure has to be machine-readable too, so scripts
  // can parse errors instead of guessing from the exit code alone.
  emitError(err);
  process.exit(1);
});
