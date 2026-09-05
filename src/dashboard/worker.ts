import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { requestSchema, commandCatalog, commandArguments, type DashboardRequest } from './catalog.js';
import { readConfig, mutateConfig, setActiveProfile, setCommunityOverride, listProfiles,
  loadCommunity, loadPlayer, saveCommunity, savePlayer, saveAuth, sessionFile, logout,
  readUiLanguage, readUiSite, readScoringOverride, readDefaultStrategy } from '../config.js';
import { setLanguage, resolveLanguage } from '../i18n/index.js';
import { setUrlBase, resolveBaseUrl, parseSite, urlBase } from '../url.js';
import { launchBrowser, getCommunities, getPlayers, login, Page } from '../browser.js';
import { CookieJar } from '../http/cookie-jar.js';
import { withAuthProfileMutation } from '../auth-profile-lock.js';
import { fetchBets, fetchBonusQuestions, fetchBonusBets, placeBets, placeBonusBets, fetchMatchdayBets,
  fetchMembers, resolveMember, placeBetsForMember } from '../core.js';
import { fetchTipStatus } from '../tip-status.js';
import { load } from 'cheerio';
import { buildDeadlineReport, warnHoursDefault } from '../analytics/deadline.js';
import { displayTimeZone, localizeMatchDates } from '../helpers/match-date.js';
import { icsCalendar } from '../notify/schedule-artifacts.js';
import { parseNotifierSettings, readNotifierConfig } from '../notify/backends.js';
import { isReadOnly } from '../read-only.js';
import { servicePaths } from '../service/paths.js';
import { readConfigurationSnapshot, serviceConfigurationSchema, setupService,
  mutateServiceConfiguration, fileRevision, initializeServiceState } from '../service/store.js';
import { writeLocalSecrets } from '../service/targets.js';
import { getServiceStatus } from '../service/status.js';
import { VERSION } from '../version.js';

const nonempty = z.string().trim().min(1).max(4096);
const matchdaySchema = z.number().int().min(1).max(34).optional();
const settingsSchema = z.object({
  revision: z.string(), language: z.enum(['de', 'en']), site: nonempty,
  timezone: nonempty.refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }),
  readOnly: z.boolean(), strategy: z.enum(['', 'safe', 'ev', 'contrarian']),
  warnHours: z.number().positive().max(8760),
  scoring: z.object({ exact: z.number().nonnegative(), goalDiff: z.number().nonnegative(),
    tendency: z.number().nonnegative(), drawExact: z.number().nonnegative().optional(),
    drawTendency: z.number().nonnegative().optional() }).strict().nullable(),
}).strict();
function revision(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function requireConfirmation(request: DashboardRequest): void {
  if (!request.confirmed) throw new Error('Bestätigung erforderlich.');
}
function settings() {
  const config = readConfig();
  return { revision: revision(config), language: resolveLanguage({ configLanguage: readUiLanguage() }),
    site: urlBase(), timezone: displayTimeZone(), readOnly: isReadOnly(), strategy: readDefaultStrategy() ?? '',
    warnHours: warnHoursDefault(), scoring: readScoringOverride(),
    environmentOverrides: Object.keys(process.env).filter(k => k.startsWith('KICKTIPP_') && process.env[k] !== undefined),
  };
}

async function execute(request: DashboardRequest): Promise<unknown> {
  // Existing CLI modules keep invocation context in module globals. One IPC
  // worker per action isolates profiles without duplicating their business logic.
  delete process.env.KICKTIPP_PROFILE;
  if (request.profile) {
    delete process.env.KICKTIPP_EMAIL;
    delete process.env.KICKTIPP_PASSWORD;
    delete process.env.KICKTIPP_COMMUNITY;
    delete process.env.KICKTIPP_PLAYER;
  }
  setActiveProfile(request.profile);
  setCommunityOverride(request.community);
  setLanguage(resolveLanguage({ configLanguage: readUiLanguage() }));
  setUrlBase(resolveBaseUrl({ configSite: readUiSite() }));
  const { operation, payload } = request;
  if (operation === 'serve') {
    const input = z.object({ logFormat: z.enum(['text', 'json']) }).strict().parse(payload);
    const { runServiceSupervisor } = await import('../service/supervisor.js');
    const stop = (message: unknown) => { if ((message as { stop?: boolean })?.stop) process.emit('SIGTERM'); };
    process.on('message', stop);
    process.once('disconnect', () => process.emit('SIGTERM'));
    process.exitCode = await runServiceSupervisor({ logFormat: input.logFormat });
    process.off('message', stop);
    return { message: 'Service beendet.' };
  }
  if (operation === 'snapshot') {
    const config = readConfig();
    const profile = request.profile ? config.profile?.[request.profile] ?? config['profile.' + request.profile] : config.auth;
    let community = null, player = null;
    try { community = loadCommunity(); player = loadPlayer(); } catch { /* new profile */ }
    const paths = servicePaths();
    let service = null, serviceError = null, serviceRevision = null;
    try { const snapshot = readConfigurationSnapshot(paths); service = snapshot.configuration; serviceRevision = snapshot.revision; }
    catch (error) { if (fs.existsSync(paths.configFile)) serviceError = error instanceof Error ? error.message : 'Service-Konfiguration ungültig.'; }
    const notifier = readNotifierConfig();
    const { program } = await import('../index.js');
    return { version: VERSION, profiles: listProfiles(), profile: request.profile, community, player,
      auth: { email: profile?.email ?? process.env.KICKTIPP_EMAIL ?? '', store: profile?.store ?? 'session',
        configured: !!profile?.email || !!(process.env.KICKTIPP_EMAIL && process.env.KICKTIPP_PASSWORD) },
      settings: settings(), notifier: { kind: notifier.kind, configured: !!notifier.target,
        fromEnvironment: !!(process.env.KICKTIPP_NOTIFY_KIND || process.env.KICKTIPP_NOTIFY_TARGET) },
      service, serviceError, serviceRevision, serviceStatus: getServiceStatus(),
      paths, platform: process.platform, commands: commandCatalog(program) };
  }
  if (operation === 'settings') {
    requireConfirmation(request);
    const input = settingsSchema.parse(payload);
    const site = parseSite(input.site)!;
    mutateConfig(config => {
      if (revision(config) !== input.revision) throw new Error('Einstellungen wurden inzwischen geändert. Bitte neu laden.');
      config.ui = { ...(config.ui ?? {}), language: input.language, site, timezone: input.timezone };
      config.server = { ...(config.server ?? {}), read_only: input.readOnly };
      config.suggest = { strategy: input.strategy };
      config.notify = { ...(config.notify ?? {}), warn_hours: input.warnHours };
      if (input.scoring) config.scoring = input.scoring;
      else delete config.scoring;
    });
    return { message: 'Einstellungen gespeichert. Umgebungsvariablen haben weiterhin Vorrang.' };
  }
  if (operation === 'login') {
    requireConfirmation(request);
    const input = z.object({ email: z.email(), password: z.string().min(1).max(4096), store: z.enum(['session', 'password']),
      site: nonempty.optional() }).strict().parse(payload);
    if (input.site) setUrlBase(parseSite(input.site)!);
    const page = new Page(new CookieJar());
    try {
      await login(page, input.email, input.password);
      await withAuthProfileMutation(request.profile, async () => {
        await saveAuth({ ...input, password: input.store === 'password' ? input.password : undefined });
        page.saveSession(sessionFile(request.profile));
      });
      // Persist only a successfully authenticated site.
      if (input.site) mutateConfig(config => { config.ui = { ...(config.ui ?? {}), site: urlBase() }; });
      return { communities: await getCommunities(page), message: 'Konto verbunden.' };
    } finally { await page.close(); }
  }
  if (operation === 'logout') { requireConfirmation(request); await logout(); return { message: 'Konto abgemeldet.' }; }
  if (operation === 'notifier') {
    requireConfirmation(request);
    const input = z.object({ kind: z.enum(['desktop', 'webhook', 'command']), target: z.string().optional() }).strict().parse(payload);
    const current = readNotifierConfig();
    const parsed = parseNotifierSettings(input.kind, input.target || (current.kind === input.kind ? current.target : undefined));
    mutateConfig(config => { config.notify = { ...parsed, ...(config.notify?.warn_hours === undefined ? {} : { warn_hours: config.notify.warn_hours }) }; });
    return { message: 'Benachrichtigung gespeichert.' };
  }
  if (operation === 'service-config') {
    requireConfirmation(request);
    const input = z.object({ revision: z.string().nullable(), configuration: serviceConfigurationSchema }).strict().parse(payload);
    const paths = servicePaths();
    if (input.revision === null) setupService(input.configuration, paths);
    else mutateServiceConfiguration(current => {
      if (fileRevision(paths.configFile) !== input.revision) throw new Error('Service wurde inzwischen geändert. Bitte neu laden.');
      if (current.job.id !== input.configuration.job.id) throw new Error('Die Job-ID darf nicht geändert werden.');
      return input.configuration;
    }, paths);
    return { message: 'Automatisierung gespeichert.' };
  }
  if (operation === 'secret') {
    requireConfirmation(request);
    const input = z.object({ value: z.string().min(1).max(16000) }).strict().parse(payload);
    const key = 'dashboard.' + crypto.randomUUID();
    writeLocalSecrets({ [key]: input.value });
    return { reference: 'local:' + key };
  }
  if (operation === 'service-initialize') {
    requireConfirmation(request);
    initializeServiceState(true);
    return { message: 'Fehlender Service-Zustand initialisiert.' };
  }
  if (operation === 'command') {
    const { program } = await import('../index.js');
    const argv = commandArguments(program, payload, request.confirmed);
    // Prevent CLI fallbacks from prompting on a worker's closed stdin.
    const localOnly = /^(guide|doctor|service |targets |remind)/.test(String(payload.command));
    if (!localOnly && !loadCommunity()) throw new Error('Bitte zuerst eine Community auswählen.');
    if (payload.command === 'admin bet') {
      const args = z.array(nonempty).min(2).parse(payload.args);
      const options = payload.options as Record<string, unknown> | undefined;
      const dryRun = options?.['dry-run'] === true;
      const matchday = options?.matchday ? matchdaySchema.parse(Number(options.matchday)) : undefined;
      const page = await launchBrowser();
      try {
        const community = loadCommunity()!;
        const member = resolveMember(await fetchMembers(page, community), args[0]);
        if (!dryRun && (payload.confirmMember !== member.name || payload.confirmMemberId !== member.tipperId)) {
          throw new Error('Mitglied muss mit Name und ID aus der aktuellen Vorschau bestätigt werden.');
        }
        return { member, dryRun, placed: await placeBetsForMember(page, community, member, args.slice(1), matchday, !dryRun, 'dashboard:admin') };
      } finally { await page.close(); }
    }
    await program.parseAsync(['node', 'kicktipp', ...argv]);
    return undefined;
  }
  const liveOperations = ['communities', 'players', 'selection', 'bets', 'bonus', 'place', 'calendar', 'tip-status', 'grid'];
  if (!liveOperations.includes(operation)) throw new Error('Unbekannte Dashboard-Funktion.');
  const input = z.object({ matchday: matchdaySchema, community: nonempty.optional(), player: nonempty.optional(),
    bets: z.array(nonempty).min(1).max(100).optional(), bonus: z.boolean().optional(),
    dryRun: z.boolean().optional(), warnHours: z.number().positive().optional() }).strict().parse(payload);
  if (operation === 'selection' || (operation === 'place' && !input.dryRun)) requireConfirmation(request);
  const page = await launchBrowser();
  try {
    if (operation === 'communities') return { communities: await getCommunities(page) };
    const community = input.community ?? loadCommunity();
    if (!community) throw new Error('Bitte zuerst eine Community auswählen.');
    if (operation === 'players') return { players: await getPlayers(page, community) };
    if (operation === 'selection') {
      if (!(await getCommunities(page)).includes(community)) throw new Error('Community gehört nicht zu diesem Konto.');
      if (input.player && !(await getPlayers(page, community)).includes(input.player)) throw new Error('Spieler wurde nicht gefunden.');
      saveCommunity(community);
      savePlayer(input.player ?? '');
      return { message: 'Auswahl gespeichert.' };
    }
    if (operation === 'tip-status') return fetchTipStatus(page, community, input.matchday);
    if (operation === 'grid') return fetchMatchdayBets(page, community, input.matchday);
    if (operation === 'bonus') return { questions: await fetchBonusQuestions(page, community), answers: await fetchBonusBets(page, community) };
    if (operation === 'place') {
      if (!input.bets?.length) throw new Error('Keine Tipps ausgewählt.');
      const placed = input.bonus
        ? await placeBonusBets(page, community, input.bets, !input.dryRun, 'dashboard:bonus')
        : await placeBets(page, community, input.bets, input.matchday, !input.dryRun, 'dashboard:bet');
      return { message: input.dryRun ? 'Tipps geprüft; noch nicht abgegeben.' : 'Tipps abgegeben.', placed };
    }
    const data = await fetchBets(page, community, input.matchday);
    const deadline = buildDeadlineReport(community, input.matchday ?? null, data.matches, { warnHours: input.warnHours });
    if (operation === 'calendar') return { download: { filename: 'kicktipp-deadlines.ics', type: 'text/calendar', content: icsCalendar(deadline) } };
    const $ = load(await page.content());
    const editable = new Set<string>();
    $('#tippabgabeSpiele tbody tr').each((_, row) => {
      const cells = $(row).children('td');
      if ($(cells[3]).find('input[id$="_heimTipp"]').length && $(cells[3]).find('input[id$="_gastTipp"]').length
        && !$(cells[3]).hasClass('nichttippbar')) editable.add($(cells[1]).text().trim() + '\0' + $(cells[2]).text().trim());
    });
    return { ...data, matches: localizeMatchDates(data.matches).map(m => ({
      ...m, editable: editable.has(m.home + '\0' + m.away),
    })), deadline };
  } finally { await page.close(); }
}

process.once('message', message => {
  void (async () => {
    try {
      const result = await execute(requestSchema.parse(message));
      if (result !== undefined) process.send?.({ result });
    } catch (error) {
      process.exitCode = 1;
      // Validation errors may contain input values; return their paths only.
      const description = error instanceof z.ZodError
        ? 'Ungültige Eingabe: ' + error.issues.map(issue => issue.path.join('.')).join(', ')
        : error instanceof Error ? error.message : 'Aktion fehlgeschlagen.';
      process.send?.({ error: description });
    } finally { process.disconnect?.(); }
  })();
});
