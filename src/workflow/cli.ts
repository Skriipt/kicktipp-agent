#!/usr/bin/env node
import { Command } from 'commander';
import { readUiSite } from '../config.js';
import { resolveBaseUrl, setUrlBase } from '../url.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { bounded } from './research.js';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { fixtureSchema, times } from './model.js';
import { Workflow } from './engine.js';
import { FileWorkflowStore } from './store.js';
import { CodexResearchProvider, HermesPredictor } from './agents.js';
import { HermesTelegramNotifier } from './notifications.js';
import { KicktippSubmissionAdapter } from './kicktipp.js';
import { McpScheduleSource } from './mcp-schedule.js';
import { orchestrate } from './orchestrator.js';

export const workflowConfigSchema = z.object({
  scope: z.object({ profile: z.string().min(1), community: z.string().min(1), season: z.string().min(1), competition: z.string().min(1), providerSeasonId: z.string().regex(/^[1-9]\d*$/) }).strict(),
  matchdays: z.array(z.number().int().min(1).max(34)).refine(a => new Set(a).size === a.length).default([]),
  store: z.string().min(1),
  pollMs: z.number().int().min(1000).max(2_147_483_647).default(15 * 60_000),
  telegram: z.object({ enabled: z.boolean().default(true), target: z.string().default('telegram') }).strict().default({ enabled: true, target: 'telegram' }),
}).strict();

export async function main(args = process.argv): Promise<void> {
  const command = new Command('workflow')
    .description('Isolated fixture workflow; research-only unless --submit is explicit')
    .requiredOption('--config <file>', 'Workflow configuration (no credentials)')
    .option('--submit', 'Enable prediction and single-match submission after independent live verification')
    .option('--test <fixtureId>', 'Run one real end-to-end test immediately; requires --submit')
    .option('--schedule', 'Print the read-only imported schedule and exit')
    .option('--research-check <fixtureId>', 'Run only currently due research for exactly one imported fixture, then exit');
  command.parse(args);
  const opts = command.opts();
  if (opts.submit && (opts.schedule || opts.researchCheck)) throw new Error('Read-only checks cannot enable submission');
  if (opts.test && (!opts.submit || opts.schedule || opts.researchCheck)) throw new Error('Test requires --submit and cannot be combined with read-only checks');
  const config = workflowConfigSchema.parse(JSON.parse(readFileSync(opts.config, 'utf8')));
  const { providerSeasonId: _providerSeason, ...identity } = config.scope;
  fixtureSchema.parse({ ...identity, matchday: '1', fixtureId: 'check', home: 'Home', away: 'Away', kickoff: Date.now() });
  setUrlBase(resolveBaseUrl({ configSite: readUiSite() }));
  const source = new McpScheduleSource(config.scope, config.matchdays);
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    if (opts.schedule) {
      const fixtures = await source.fetch(stop.signal);
      console.log(JSON.stringify(fixtures.map(f => ({ ...f, minutesUntilKickoff: Math.floor((f.kickoff - Date.now()) / 60_000) })), null, 2));
      return;
    }
    if (opts.test) {
      const candidates = (await source.fetch(stop.signal)).filter(f => f.fixtureId === opts.test);
      if (candidates.length !== 1) throw new Error('Test fixture missing or ambiguous');
      const fixture = candidates[0];
      if (Date.now() >= fixture.kickoff) throw new Error('Test fixture has already kicked off');
      const submission = new KicktippSubmissionAdapter(config.scope);
      console.log('TEST: checking authentication, fixture identity and existing tip before model calls.');
      const existing = await bounded(30_000, signal => submission.read(fixture, signal), stop.signal);
      if (existing) throw new Error('Test fixture already has a tip');
      const root = mkdtempSync(resolve(tmpdir(), 'kicktipp-workflow-test-'));
      const store = new FileWorkflowStore(root, 'test');
      console.log(`TEST: real model calls and real single-fixture submission; artifacts: ${root}`);
      const workflow = new Workflow(store, () => new CodexResearchProvider(), new HermesPredictor(), submission, undefined, {
        testMode: true, mode: 'full',
        notifier: config.telegram.enabled ? new HermesTelegramNotifier(config.telegram.target) : undefined,
      });
      await workflow.tick(fixture, stop.signal);
      const state = store.read(fixture);
      console.log(JSON.stringify({ test: true, realSubmission: true, fixtureId: fixture.fixtureId,
        status: state.status, confirmedAt: state.confirmedAt, files: store.files(fixture) }, null, 2));
      if (state.status !== 'submitted') throw new Error('End-to-end test did not confirm submission');
      return;
    }
    const store = new FileWorkflowStore(resolve(dirname(resolve(opts.config)), config.store));
    const mode = opts.submit ? 'full' : 'research-only';
    const workflow = new Workflow(store, () => new CodexResearchProvider(), new HermesPredictor(),
      new KicktippSubmissionAdapter(config.scope), undefined, {
        mode, notifier: !opts.researchCheck && config.telegram.enabled ? new HermesTelegramNotifier(config.telegram.target) : undefined,
      });
    if (opts.researchCheck) {
      const candidates = (await source.fetch(stop.signal)).filter(f => f.fixtureId === opts.researchCheck);
      if (candidates.length !== 1) throw new Error('Research fixture missing or ambiguous');
      const f = candidates[0];
      if (Date.now() < times(f).r1 || Date.now() >= f.kickoff) throw new Error('Research fixture is outside its real research window');
      await workflow.tick(f, stop.signal);
      const state = store.read(f);
      console.log(JSON.stringify({ status: state.status, r1Complete: !!state.r1?.complete, r2Complete: !!state.r2?.complete, evidence: (state.r1?.evidence.length ?? 0) + (state.r2?.evidence.length ?? 0) }));
      if (!state.r1?.complete || (Date.now() >= times(f).r2 && !state.r2?.complete)) throw new Error('Research-only validation incomplete');
      return;
    }
    const recovered = store.recover();
    if (recovered.some(f => Object.entries(identity).some(([key, value]) => f[key as keyof typeof identity] !== value))) throw new Error('Store belongs to a different workflow scope');
    await orchestrate(source, workflow, stop.signal, { pollMs: config.pollMs, recovered, onError: reason => console.error(`Workflow: ${reason}`) });
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Workflow stopped: configuration, identity, authentication or research verification failed.'); process.exitCode = 1; });
}
