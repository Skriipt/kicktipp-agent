#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyServiceConfig, readServiceConfig, serviceConfigFile, type ServiceConfig } from './settings.js';

export async function startService(config: ServiceConfig = readServiceConfig()) {
  applyServiceConfig(config);
  const [{ startHttpService }, { kicktippQueue }, { DeadlineScheduler }, { launchBrowser },
    { fetchBets }, { buildDeadlineReport }, { VERSION }] = await Promise.all([
    import('./http.js'), import('./queue.js'), import('./scheduler.js'), import('../browser.js'),
    import('../core.js'), import('../analytics/deadline.js'), import('../version.js'),
  ]);
  const scheduler = new DeadlineScheduler({
    ...config.notifications,
    stateFile: path.join(process.env.KICKTIPP_DATA_DIR!, 'notifications.json'),
    fetchReport: () => kicktippQueue.run(async () => {
      const page = await launchBrowser();
      try {
        const { matches } = await fetchBets(page, config.account.community);
        return buildDeadlineReport(config.account.community, null, matches, {
          warnHours: Math.max(...config.notifications.warnHours), timeZone: config.timeZone,
        });
      } finally { await page.close(); }
    }),
  });
  const startedAt = new Date().toISOString();
  const http = await startHttpService({
    ...config.server,
    status: () => ({ version: VERSION, startedAt, community: config.account.community,
      readOnly: config.server.readOnly, scheduler: scheduler.status() }),
  });
  scheduler.start();
  return {
    http, scheduler,
    async close() {
      // Stop accepting work, finish in-flight writes, then release the process.
      await Promise.all([http.close(), scheduler.stop()]);
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
  console.log(`Kicktipp service listening on port ${service.http.port}. MCP: /mcp; status: /status.`);
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
