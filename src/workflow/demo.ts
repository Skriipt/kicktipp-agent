/** Offline vertical example. All names, sources and predictions are synthetic;
 * this module never imports a Kicktipp client or a notification provider. */
import path from 'node:path';
import { Workflow, type Clock } from './engine.js';
import { FileWorkflowStore } from './store.js';
import { fixtureKey, times, type Fixture, type Prediction, type Source } from './model.js';
import type { ResearchProvider } from './research.js';

const fixture: Fixture = { profile: 'demo', community: 'offline', season: '2026-27', competition: 'synthetic', matchday: '1', fixtureId: 'demo-1', home: 'Demo Home', away: 'Demo Away', kickoff: Date.UTC(2026, 8, 12, 18) };
let now = times(fixture).r1 - 60_000;
const clock: Clock = {
  now: () => now,
  sleep: async milliseconds => {
    console.log(`Local scheduler advances ${milliseconds / 60_000} minutes`);
    now += milliseconds;
  },
};
const createResearchSession = (): ResearchProvider => {
  const pages = new Map<string, Source>();
  return {
    search: async () => [...pages.keys()],
    open: async url => {
      const source = pages.get(url);
      if (!source) throw new Error('Unknown synthetic original');
      return structuredClone(source);
    },
    investigate: async ({ fixture: f, phase, categories }, tools) => {
      const findings = [];
      for (const category of categories) {
        const url = `https://sources.invalid/${f.fixtureId}/${phase}/${category}`;
        pages.set(url, { url, text: `Synthetic ${category} observation for ${f.home} and ${f.away}.`,
          publishedAt: now, reliability: 'primary', scope: 'match', season: f.season, competition: f.competition,
          teams: [f.home, f.away], fixtureId: f.fixtureId, kickoff: f.kickoff, kind: 'current' });
        const original = await tools.open(url);
        for (const team of [f.home, f.away]) findings.push({ url, category, team, subject: category, quote: original.text, claim: original.text });
      }
      return { findings, uncertainties: ['OFFLINE DEMO: invented test data, unsuitable for real tips.'] };
    },
  };
};
const store = new FileWorkflowStore(path.resolve('data/workflow-demo'));
let receipt: { fixture: Fixture; score: Prediction['score'] } | null = null;
const workflow = new Workflow(store, createResearchSession, {
  predict: async finalDossier => {
    if (!finalDossier.includes('## R2 (complete)')) throw new Error('Missing final R2');
    return { fixtureKey: fixtureKey(fixture), probabilities: { home: 0.5, draw: 0.3, away: 0.2 },
      expectedGoals: { home: 1.5, away: 0.9 }, score: { home: 2, away: 1 }, confidence: 0.5,
      factors: [{ reason: 'Synthetic demo only', sourceUrl: `https://sources.invalid/${fixture.fixtureId}/r2/confirmed_lineups` }] };
  },
}, {
  submit: async (f, score, { signal, now }) => {
    signal.throwIfAborted();
    if (now() < times(f).submission || now() >= f.kickoff) throw new Error('Outside window');
    receipt = { fixture: f, score };
    console.log(`FAKE submission: ${f.home} vs ${f.away} ${score.home}:${score.away}`);
  },
  read: async () => receipt,
}, clock);
await workflow.run([fixture], new AbortController().signal);
console.log(`State: ${store.read(fixture).status}`);
console.log(`Dossier: ${store.files(fixture).dossier}`);
