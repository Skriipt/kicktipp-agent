#!/usr/bin/env node

import { Command } from 'commander';
import { VERSION } from './version.js';
import { spawn } from 'child_process';
import {
  saveCommunity,
  savePlayer,
  logout,
  listProfiles,
  setActiveProfile,
  setCommunityOverride,
  getActiveProfile,
  readUiLanguage,
  readUiSite,
  saveUiLanguage,
  saveUiSite,
} from './config.js';
import { startSetupListener } from './setup/listener.js';
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
import { registerTipStatusCommand } from './commands/tip-status.js';
import { registerGuideCommand } from './commands/guide.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerCacheCommand } from './commands/cache.js';
import { registerStatsCommand } from './commands/stats.js';
import { registerRivalCommand } from './commands/rival.js';
import { registerSuggestCommand } from './commands/suggest.js';
import { registerDeadlineCommand } from './commands/deadline.js';
import { registerNotifyCommand, registerRemindCommand, registerSetNotifyCommand } from './commands/remind.js';
import { registerLogCommand } from './commands/log.js';
import { registerScenarioCommand } from './commands/scenario.js';
import { registerWhatifCommand } from './commands/whatif.js';
import { registerAdminCommand } from './commands/admin.js';
import { registerTuiCommand } from './commands/tui.js';
import { currentLanguage, parseLanguage, resolveLanguage, setLanguage, t } from './i18n/index.js';
import { parseSite, resolveBaseUrl, setUrlBase, siteLabel, urlBase } from './url.js';

setLanguage(resolveLanguage({ configLanguage: readUiLanguage() }));
setUrlBase(resolveBaseUrl({ configSite: readUiSite() }));

const program = new Command();

async function setCommunityInteractive(page: any): Promise<void> {
  const all = await getCommunities(page);
  if (!all.length) { console.error(t('common.noCommunities')); process.exit(1); }
  console.log(t('common.availableCommunities'));
  all.forEach((c, i) => console.log(`  [${i + 1}] ${c}`));
  const choice = await ask(t('common.selectCommunity', { n: all.length }));
  const idx = parseInt(choice) - 1;
  if (isNaN(idx) || idx < 0 || idx >= all.length) { console.error(t('common.invalidSelection')); process.exit(1); }
  saveCommunity(all[idx]);
  console.log(t('common.savedCommunity', { name: all[idx] }));
}

async function setPlayerInteractive(page: any, community: string): Promise<void> {
  const players = await getPlayers(page, community);
  if (!players.length) { console.error(t('common.noPlayers')); process.exit(1); }
  console.log(t('common.players'));
  players.forEach((p, i) => console.log(`  [${i + 1}] ${p}`));
  const choice = await ask(t('common.selectPlayer', { n: players.length }));
  const idx = parseInt(choice) - 1;
  if (isNaN(idx) || idx < 0 || idx >= players.length) { console.error(t('common.invalidSelection')); process.exit(1); }
  savePlayer(players[idx]);
  console.log(t('common.savedPlayer', { name: players[idx] }));
}

program
  .name('kicktipp')
  .description(t('program.description'))
  .version(VERSION)
  .option('-c, --community <slug>', t('program.optionCommunity'))
  .option('-p, --profile <name>', t('program.optionProfile'))
  .option('--lang <code>', t('program.optionLang'))
  .option('--site <host>', t('program.optionSite'))
  .hook('preAction', (command) => {
    // Applied before every subcommand so the flags work everywhere without
    // each command having to know about them.
    const opts = command.opts();
    if (opts.profile) setActiveProfile(opts.profile);
    if (opts.community) setCommunityOverride(opts.community);
  });

program
  .command('profiles')
  .description(t('cmd.profiles.description'))
  .option('--json', t('opt.json'))
  .action((opts) => {
    const profiles = listProfiles();
    const active = getActiveProfile();
    if (opts.json) {
      emitJson({ active, profiles });
      return;
    }
    if (!profiles.length) {
      console.log(t('profiles.none'));
      console.log(t('profiles.addOne'));
      return;
    }
    for (const name of profiles) {
      console.log(`${name === active ? '*' : ' '} ${name}`);
    }
  });

program
  .command('login')
  .description(t('cmd.login.description'))
  .option('--web', t('cmd.login.optionWeb'))
  .action(async (opts) => {
    if (!opts.web) {
      const page = await launchBrowser();
      try {
        await setCommunityInteractive(page);
      } finally {
        await page.close();
      }
      return;
    }
    const handle = await startSetupListener();
    console.log(t('login.openPage', { url: handle.url }));
    if (process.platform === 'darwin') {
      spawn('open', [handle.url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', handle.url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [handle.url], { detached: true, stdio: 'ignore' }).unref();
    }
    const outcome = await handle.finished;
    if (outcome === 'saved') {
      console.log(t('login.connected'));
      return;
    }
    if (outcome === 'timeout') {
      console.error(t('login.timeout'));
      process.exit(1);
    }
    console.error(t('login.unfinished'));
    process.exit(1);
  });

program
  .command('logout')
  .description(t('cmd.logout.description'))
  .action(() => logout());

program
  .command('communities')
  .description(t('cmd.communities.description'))
  .option('--json', t('opt.json'))
  .action(async (opts) => {
    if (opts.json) setJsonMode(true);
    const page = await launchBrowser();
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
  .description(t('cmd.setCommunity.description'))
  .action(async () => {
    const page = await launchBrowser();
    await setCommunityInteractive(page);
    await page.close();
  });

program
  .command('set-lang')
  .description(t('cmd.setLang.description'))
  .argument('[code]', t('cmd.setLang.argument'))
  .action((code?: string) => {
    const language = parseLanguage(code);
    if (!language) {
      console.log(t('ui.currentLanguage', { code: currentLanguage() }));
      return;
    }
    saveUiLanguage(language);
    setLanguage(language);
    console.log(t('ui.savedLanguage', { code: language }));
  });

program
  .command('set-site')
  .description(t('cmd.setSite.description'))
  .argument('[site]', t('cmd.setSite.argument'))
  .action((site?: string) => {
    const base = parseSite(site);
    if (!base) {
      console.log(t('ui.currentSite', { site: siteLabel(urlBase()), url: urlBase() }));
      return;
    }
    saveUiSite(siteLabel(base));
    setUrlBase(base);
    console.log(t('ui.savedSite', { site: siteLabel(base), url: base }));
  });

program
  .command('players')
  .description(t('cmd.players.description'))
  .option('--json', t('opt.json'))
  .action(async (opts) => {
    if (opts.json) setJsonMode(true);
    const page = await launchBrowser();
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
  .description(t('cmd.setPlayer.description'))
  .action(async () => {
    const page = await launchBrowser();
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
registerTipStatusCommand(program);
registerGuideCommand(program);
registerSyncCommand(program);
registerCacheCommand(program);
registerStatsCommand(program);
registerRivalCommand(program);
registerSuggestCommand(program);
registerDeadlineCommand(program);
registerRemindCommand(program);
registerNotifyCommand(program);
registerSetNotifyCommand(program);
registerLogCommand(program);
registerScenarioCommand(program);
registerWhatifCommand(program);
registerAdminCommand(program);
registerTuiCommand(program);

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
