#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { applyServiceConfig, configuredCommunities, readServiceConfig, writeServiceConfig, serviceConfigFile, type ServiceConfig } from './settings.js';
import { ensureWebToken } from './web-token.js';
import { AdminError, createAdminController } from './admin.js';
import type { DeadlineReport } from '../analytics/deadline.js';

function initialConfig(): ServiceConfig | null {
  return fs.existsSync(serviceConfigFile()) ? readServiceConfig() : null;
}

export async function startService(config: ServiceConfig | null = initialConfig()) {
  // Capture instance paths before account scoping changes the data directory.
  const configFile = serviceConfigFile();
  process.env.KICKTIPP_SERVICE_CONFIG = configFile;
  const adminToken = ensureWebToken();
  let activeConfig = config ? structuredClone(config) : null;
  const host = config?.server.host ?? process.env.KICKTIPP_LISTEN_HOST ?? '0.0.0.0';
  const port = config?.server.port ?? Number(process.env.KICKTIPP_LISTEN_PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid service port.');
  if (activeConfig) applyServiceConfig(activeConfig);
  const [{ startHttpService }, { kicktippQueue }, { DeadlineScheduler }, browser,
    { fetchBets, AuthError }, { buildDeadlineReport }, { VERSION }, urls, { discardSession }, { SessionOnlyExpiredError }, { fetchBonusReminders }] = await Promise.all([
    import('./http.js'), import('./queue.js'), import('./scheduler.js'), import('../browser.js'),
    import('../core.js'), import('../analytics/deadline.js'), import('../version.js'), import('../url.js'), import('../server.js'), import('../config.js'), import('../bonus-reminders.js'),
  ]);
  urls.setUrlBase(urls.resolveBaseUrl());
  let report: DeadlineReport | null = null;
  let reports: DeadlineReport[] = [];
  // Manual reads and scheduled reads share freshness, but only scheduled runs
  // report notification delivery outcomes.
  let read: { lastCheck: string | null; lastSuccess: string | null; lastError: 'auth_required' | 'check_failed' | null } = {
    lastCheck: null, lastSuccess: null, lastError: null,
  };
  const readReports = (current: ServiceConfig) => kicktippQueue.run(async () => {
    read.lastCheck = new Date().toISOString();
    const next: DeadlineReport[] = [];
    const communities = configuredCommunities(current);
    const blank = (community: string) => buildDeadlineReport(community, null, [], {
      warnHours: Math.max(0, ...current.notifications.warnHours), timeZone: current.timeZone,
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
            warnHours: Math.max(0, ...current.notifications.warnHours), timeZone: current.timeZone,
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
    }
    finally { await page?.close(); }
    reports = next;
    report = reports.find(group => group.community === current.account.community && !group.readError) ?? null;
    read.lastError = reports.some(group => group.readError === 'auth_required') ? 'auth_required'
      : reports.some(group => group.readError || group.bonusCheckFailed) ? 'check_failed' : null;
    if (!read.lastError) read.lastSuccess = new Date().toISOString();
    return reports;
  });
  function makeScheduler(current: ServiceConfig) {
    return new DeadlineScheduler({ ...current.notifications,
      stateFile: path.join(process.env.KICKTIPP_DATA_DIR!, 'notifications.json'),
      fetchReport: () => readReports(current),
    });
  }
  let scheduler = activeConfig ? makeScheduler(activeConfig) : null;
  const startedAt = new Date().toISOString();
  const status = () => ({ version: VERSION, startedAt, configured: !!activeConfig,
    read: { ...read },
    community: activeConfig?.account.community ?? null, readOnly: activeConfig?.server.readOnly ?? true,
    communities: activeConfig ? configuredCommunities(activeConfig) : [],
    groupErrors: reports.filter(group => group.readError || group.bonusCheckFailed)
      .map(group => ({ community: group.community, code: group.readError ?? 'check_failed' })),
    scheduler: scheduler?.status() ?? { running: false, lastCheck: null, lastSuccess: null,
      nextCheck: null, lastError: null, failedChannels: [], deliveredCount: 0, unresolvedBonusQuestions: 0 },
  });
  const overview = async () => ({ status: status(), report, reports });
  let closing = false;
  const admin = createAdminController({
    getConfig: () => activeConfig,
    serverDefaults: { host, port }, status, overview,
    check: async () => {
      if (!activeConfig) throw new AdminError('setup_required', 409);
      const refreshed = await readReports(activeConfig);
      if (refreshed.every(group => group.readError)) throw new AdminError('check_failed', 502);
      return overview();
    },
    checkAccount: account => kicktippQueue.run(async () => {
      // A candidate login gets its own in-memory cookie jar and cannot replace
      // the active account's persisted session or base URL.
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
      // A terminal edit has not been activated yet; do not silently overwrite it.
      const diskConfig = fs.existsSync(configFile) ? readServiceConfig(configFile) : null;
      // Optional undefined properties disappear when written as JSON.
      if (!isDeepStrictEqual(diskConfig, JSON.parse(JSON.stringify(activeConfig)))) throw new AdminError('restart_required', 409);
      // HTTP dispatch gates all MCP/admin calls around this operation. Stop the
      // scheduler outside the Kicktipp queue so an already queued read can end.
      const previous = activeConfig;
      const previousScheduler = scheduler;
      await previousScheduler?.stop();
      const previousEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('KICKTIPP_')));
      const previousBase = urls.urlBase();
      try {
        await kicktippQueue.run(async () => {
          await discardSession();
          applyServiceConfig(candidate);
          urls.setUrlBase(urls.resolveBaseUrl());
          // Construct before committing: corrupt account state must not leave a
          // half-applied configuration or replace a valid settings file.
          const replacement = makeScheduler(candidate);
          writeServiceConfig(candidate, configFile);
          activeConfig = candidate;
          scheduler = replacement;
          report = null;
          reports = [];
          read = { lastCheck: null, lastSuccess: null, lastError: null };
        });
      } catch (error) {
        for (const key of Object.keys(process.env)) if (key.startsWith('KICKTIPP_')) delete process.env[key];
        Object.assign(process.env, previousEnv);
        urls.setUrlBase(previousBase);
        activeConfig = previous;
        scheduler = previousScheduler;
        previousScheduler?.start();
        throw error;
      }
      scheduler?.start();
    },
  });
  const http = await startHttpService({
    host, port, token: () => activeConfig?.server.token ?? null,
    allowedOrigins: config?.server.allowedOrigins,
    web: { token: adminToken, allowedOrigins: config?.server.allowedOrigins,
      handle: (pathname, method, body) => admin.handle(pathname, method, body) },
    status,
  });
  scheduler?.start();
  return {
    http, get scheduler() { return scheduler; },
    async close() {
      closing = true;
      await Promise.all([http.close(), scheduler?.stop()]);
      // An accepted config operation may finish during listener shutdown.
      await scheduler?.stop();
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
    if (fs.existsSync(serviceConfigFile())) applyServiceConfig(readServiceConfig());
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
