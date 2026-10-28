#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { configuredCommunities, readServiceConfig, writeServiceConfig, serviceConfigFile, validateServiceConfig, resolveServiceProfile, serviceProfileDataDir, type ServiceConfig, type LegacyServiceConfig, type ServiceProfile } from './settings.js';
import { ensureWebToken } from './web-token.js';
import { sendNotification } from '../notify/backends.js';
import { createProfileAccess } from './profiles.js';
import { AdminError, createAdminController } from './admin.js';
import type { DeadlineReport } from '../analytics/deadline.js';

function initialConfig(): ServiceConfig | null {
  return fs.existsSync(serviceConfigFile()) ? readServiceConfig() : null;
}

export async function startService(config: ServiceConfig | LegacyServiceConfig | null = initialConfig()) {
  const configFile = serviceConfigFile();
  process.env.KICKTIPP_SERVICE_CONFIG = configFile;
  const adminToken = ensureWebToken();
  let activeConfig = config ? validateServiceConfig(config) : null;
  const host = activeConfig?.server.host ?? process.env.KICKTIPP_LISTEN_HOST ?? '0.0.0.0';
  const port = activeConfig?.server.port ?? Number(process.env.KICKTIPP_LISTEN_PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid service port.');
  const [{ startHttpService }, { kicktippQueue }, { DeadlineScheduler }, browser,
    { fetchBets, AuthError }, { buildDeadlineReport }, { VERSION }, urls, { discardSession }, { SessionOnlyExpiredError }, { fetchBonusReminders }] = await Promise.all([
    import('./http.js'), import('./queue.js'), import('./scheduler.js'), import('../browser.js'),
    import('../core.js'), import('../analytics/deadline.js'), import('../version.js'), import('../url.js'), import('../server.js'), import('../config.js'), import('../bonus-reminders.js'),
  ]);
  const profileAccess = createProfileAccess(() => activeConfig);
  type ProfileState = {
    report: DeadlineReport | null;
    reports: DeadlineReport[];
    read: { lastCheck: string | null; lastSuccess: string | null; lastError: 'auth_required' | 'check_failed' | null };
    scheduler: InstanceType<typeof DeadlineScheduler>;
  };
  const emptyScheduler = () => ({ running: false, lastCheck: null, lastSuccess: null,
    nextCheck: null, lastError: null, failedChannels: [], deliveredCount: 0, unresolvedBonusQuestions: 0 });
  const emptyRead = (): ProfileState['read'] => ({ lastCheck: null, lastSuccess: null, lastError: null });
  let states = new Map<string, ProfileState>();
  const readReports = (profile: ServiceProfile, state: ProfileState) => kicktippQueue.run(() =>
    profileAccess.withProfile(profile.id, async () => {
      state.read.lastCheck = new Date().toISOString();
      const next: DeadlineReport[] = [];
      const communities = configuredCommunities(profile);
      const blank = (community: string) => buildDeadlineReport(community, null, [], {
        warnHours: Math.max(0, ...profile.notifications.warnHours), timeZone: profile.timeZone,
      });
      const errorCode = (error: unknown) => error instanceof AuthError || error instanceof SessionOnlyExpiredError
        ? 'auth_required' as const : 'check_failed' as const;
      let page: InstanceType<typeof browser.Page> | undefined;
      try {
        page = await browser.launchBrowser();
        for (const community of communities) {
          try {
            const result = await fetchBets(page, community);
            const group = buildDeadlineReport(community, null, result.matches, {
              warnHours: Math.max(0, ...profile.notifications.warnHours), timeZone: profile.timeZone,
            });
            try { group.bonusQuestions = await fetchBonusReminders(page, community); }
            catch { group.bonusCheckFailed = true; }
            next.push(group);
          } catch (error) {
            next.push({ ...blank(community), readError: errorCode(error) });
          }
        }
      } catch (error) {
        for (const community of communities) next.push({ ...blank(community), readError: errorCode(error) });
      } finally { await page?.close(); }
      state.reports = next;
      state.report = next.find(group => group.community === profile.account.community && !group.readError) ?? null;
      state.read.lastError = next.some(group => group.readError === 'auth_required') ? 'auth_required'
        : next.some(group => group.readError || group.bonusCheckFailed) ? 'check_failed' : null;
      if (!state.read.lastError) state.read.lastSuccess = new Date().toISOString();
      return next;
    }));
  function makeStates(current: ServiceConfig | null) {
    return new Map(current?.profiles.map(profile => {
      const state: ProfileState = { report: null, reports: [], read: emptyRead(), scheduler: new DeadlineScheduler({
        ...profile.notifications,
        stateFile: path.join(serviceProfileDataDir(current, profile, configFile), 'notifications.json'),
        fetchReport: () => readReports(profile, state),
        send: (channel, payload) => sendNotification(channel, { ...payload,
          profile: { id: profile.id, name: profile.name }, summary: `[${profile.name}] ${payload.summary}` }),
      }) };
      return [profile.id, state] as const;
    }) ?? []);
  }
  states = makeStates(activeConfig);
  const startedAt = new Date().toISOString();
  const profileStatus = (profile: ServiceProfile) => {
    const state = states.get(profile.id);
    return { id: profile.id, name: profile.name, community: profile.account.community, readOnly: profile.readOnly,
      communities: configuredCommunities(profile),
      groupErrors: (state?.reports ?? []).filter(group => group.readError || group.bonusCheckFailed)
        .map(group => ({ community: group.community, code: group.readError ?? 'check_failed' })),
      read: { ...(state?.read ?? emptyRead()) }, scheduler: state?.scheduler.status() ?? emptyScheduler() };
  };
  const status = (id?: string) => {
    const profiles = activeConfig?.profiles ?? [];
    const selected = id === undefined ? (profiles.length === 1 ? profiles[0] : undefined)
      : profiles.find(profile => profile.id === id);
    if (id !== undefined && !selected) throw new AdminError('profile_not_found', 404);
    return { version: VERSION, startedAt, configured: profiles.length > 0,
      read: emptyRead(), community: null, communities: [], groupErrors: [], readOnly: profiles.every(profile => profile.readOnly), scheduler: emptyScheduler(),
      ...(selected ? profileStatus(selected) : {}), profiles: profiles.map(profileStatus) };
  };
  const overview = async (id?: string) => {
    const state = states.get(id ?? activeConfig?.profiles[0]?.id ?? '');
    return { status: status(id), report: state?.report ?? null, reports: state?.reports ?? [] };
  };
  const startSchedulers = () => { for (const state of states.values()) state.scheduler.start(); };
  const stopSchedulers = () => Promise.all([...states.values()].map(state => state.scheduler.stop()));
  let closing = false;
  const admin = createAdminController({
    getConfig: () => activeConfig,
    serverDefaults: { host, port }, status, overview,
    check: async id => {
      if (!activeConfig) throw new AdminError('setup_required', 409);
      const profile = resolveServiceProfile(activeConfig, id);
      const refreshed = await readReports(profile, states.get(profile.id)!);
      if (refreshed.every(group => group.readError)) throw new AdminError('check_failed', 502);
      return overview(profile.id);
    },
    checkAccount: account => kicktippQueue.run(async () => {
      const previousBase = urls.urlBase();
      const page = new browser.Page();
      try {
        urls.setUrlBase(urls.resolveBaseUrl({ argv: [], env: { ...process.env, KICKTIPP_SITE: account.site } }));
        await browser.login(page, account.email, account.password);
        return await browser.getCommunities(page);
      } finally { urls.setUrlBase(previousBase); await page.close(); }
    }),
    applyConfig: async candidate => {
      if (closing) throw new AdminError('stopping', 503);
      const diskConfig = fs.existsSync(configFile) ? readServiceConfig(configFile) : null;
      if (!isDeepStrictEqual(diskConfig, JSON.parse(JSON.stringify(activeConfig)))) throw new AdminError('restart_required', 409);
      // Drain scheduler reads before taking the operation queue. HTTP dispatch
      // separately gates admin edits against MCP calls, so no caller sees half a save.
      await stopSchedulers();
      try {
        await kicktippQueue.run(async () => {
          await discardSession();
          const replacement = makeStates(candidate);
          writeServiceConfig(candidate, configFile);
          activeConfig = candidate;
          states = replacement;
        });
      } finally { if (!closing) startSchedulers(); }
    },
  });
  const http = await startHttpService({
    host, port, token: () => activeConfig?.server.token ?? null,
    allowedOrigins: activeConfig?.server.allowedOrigins,
    web: { token: adminToken, allowedOrigins: activeConfig?.server.allowedOrigins,
      handle: (pathname, method, body) => admin.handle(pathname, method, body) },
    status, profileAccess,
  });
  startSchedulers();
  return {
    http,
    get scheduler() { return states.size === 1 ? [...states.values()][0].scheduler : null; },
    async close() {
      closing = true;
      await Promise.all([http.close(), stopSchedulers()]);
      await stopSchedulers();
      await kicktippQueue.idle();
    },
  };
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'serve';
  if (command === 'setup') {
    const { runSetup } = await import('../setup-cli.js');
    await runSetup({ notificationsOnly: process.argv.includes('--notifications') });
    return;
  }
  if (command === 'web-token') {
    console.log(ensureWebToken());
    return;
  }
  if (command === 'connection') {
    const config = readServiceConfig();
    console.log(`MCP: http://127.0.0.1:8787/mcp\nAuthorization: Bearer ${config.server.token}`);
    return;
  }
  if (command === 'status') {
    const config = readServiceConfig();
    const response = await fetch(`http://127.0.0.1:${config.server.port}/status`, {
      headers: { Authorization: `Bearer ${config.server.token}` }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Dienststatus konnte nicht abgerufen werden. Läuft der Container?');
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }
  if (command !== 'serve') {
    if (command === 'mcp-stdio') {
      const { startStdio } = await import('../server.js');
      await startStdio();
      return;
    }
    await import('../index.js');
    return;
  }
  const service = await startService();
  console.log(`Kicktipp service listening on port ${service.http.port}. Web: /; MCP: /mcp; status: /status.`);
  console.log('Web access token: docker compose exec kicktipp node dist/service/main.js web-token');
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    // Compose gives in-flight verified submissions time to reconcile.
    service.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
}
