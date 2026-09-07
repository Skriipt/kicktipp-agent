import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileLock, LockUnavailableError } from '../src/service/lock.js';
import { Workflow, nextDue, type Clock, type SubmissionAdapter } from '../src/workflow/engine.js';
import { FileWorkflowStore } from '../src/workflow/store.js';
import { categories, dossier, fixtureKey, inSubmissionWindow, MINUTE, times, type Fixture, type Prediction, type Source } from '../src/workflow/model.js';
import { formatNotification, type NotificationEvent, type Notifier } from '../src/workflow/notifications.js';
import { freeFirecrawlSession } from '../src/workflow/firecrawl.js';
import { bounded, evidenceGate, research, ResearchPaused, type ResearchProvider } from '../src/workflow/research.js';

const kickoff = Date.UTC(2026, 8, 12, 18);
const fixture: Fixture = { profile: 'test', community: 'fake', season: '2026/27', competition: 'league', matchday: '3', fixtureId: '42', home: 'Home', away: 'Away', kickoff };
let root: string;
let now: number;
let store: FileWorkflowStore;
let clock: Clock;
let provider: ResearchProvider;
let submission: SubmissionAdapter;
let workflow: Workflow;
let saved: { fixture: Fixture; score: Prediction['score'] } | null;
const url = (f: Fixture, category: string) => `https://original.example/${f.fixtureId}/${category}`;
function original(f = fixture, category = 'team_form'): Source {
  return { url: url(f, category), text: `${f.home}: checked ${category}`, publishedAt: now,
    reliability: 'primary', scope: 'team', season: f.season, competition: f.competition, teams: [f.home], kind: 'current' };
}
function fakeResearch(): ResearchProvider {
  const pages = new Map<string, Source>();
  return {
    search: vi.fn(async () => []),
    open: vi.fn(async url => structuredClone(pages.get(url)!)),
    investigate: vi.fn(async ({ fixture: f, categories: required }, tools) => {
      const findings = [];
      for (const category of required) {
        const source: Source = { ...original(f, category), scope: 'match', teams: [f.home, f.away], fixtureId: f.fixtureId, kickoff: f.kickoff };
        pages.set(source.url, source);
        const opened = await tools.open(source.url);
        for (const team of [f.home, f.away]) findings.push({ url: opened.url, category, team, subject: category, quote: opened.text, claim: opened.text });
      }
      return { findings, uncertainties: ['Synthetic test data; no real-world claims.'] };
    }),
  };
}
function predictor() {
  return { predict: vi.fn(async (markdown: string) => {
    const key = markdown.match(/^Fixture: (.+)$/m)![1];
    const sourceUrl = markdown.match(/Source: (\S+)/)![1];
    return { fixtureKey: key, probabilities: { home: 0.5, draw: 0.3, away: 0.2 },
      expectedGoals: { home: 1.5, away: 0.8 }, score: { home: 2, away: 1 }, confidence: 0.6,
      factors: [{ reason: 'Synthetic checked source', sourceUrl }] };
  }) };
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(process.cwd(), '.workflow-test-'));
  now = times(fixture).r1;
  store = new FileWorkflowStore(root);
  clock = { now: () => now, sleep: vi.fn(async ms => { now += ms; }) };
  provider = fakeResearch(); saved = null;
  submission = { submit: vi.fn(async (f, score) => { saved = { fixture: f, score }; }), read: vi.fn(async () => saved) };
  workflow = new Workflow(store, () => ({ ...provider }), predictor(), submission, clock);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
async function ready(f = fixture) {
  now = times(f).r1; await workflow.tick(f);
  now = times(f).r2; await workflow.tick(f);
  expect(store.read(f).status).toBe('refreshed');
}

describe('fixture pipeline and local scheduling', () => {
  it.each([-1, 0, 1, 50 * MINUTE - 1, 50 * MINUTE])('enforces the inclusive opening and exclusive kickoff (%s)', delta => {
    expect(inSubmissionWindow(fixture, times(fixture).submission + delta)).toBe(delta >= 0 && delta < 50 * MINUTE);
  });
  it('sleeps exactly until R1, R2 and submission without AI polling', async () => {
    now = times(fixture).r1 - MINUTE;
    await workflow.run([fixture], new AbortController().signal);
    expect(clock.sleep).toHaveBeenNthCalledWith(1, MINUTE, expect.any(AbortSignal));
    expect(clock.sleep).toHaveBeenNthCalledWith(2, 210 * MINUTE, expect.any(AbortSignal));
    expect(clock.sleep).toHaveBeenNthCalledWith(3, 40 * MINUTE, expect.any(AbortSignal));
    expect(provider.investigate).toHaveBeenCalledTimes(2);
    expect(submission.submit).toHaveBeenCalledTimes(1);
    expect(store.read(fixture).history.map(h => h.status)).toEqual(['researched', 'refreshed', 'predicted', 'waiting_for_submission_window', 'eligible_for_submission', 'submitted']);
  });
  it('preserves future games and never submits at or after kickoff', async () => {
    now = times(fixture).r1 - 1; await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('scheduled');
    await ready(); now = kickoff; await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('kickoff_passed');
    expect(submission.submit).not.toHaveBeenCalled();
    expect(nextDue(store.read(fixture), now)).toBeUndefined();
  });
  it('starts R2 only at its fixture deadline, and submission only in its own window', async () => {
    const later = { ...fixture, fixtureId: '43', kickoff: kickoff + 30 * MINUTE };
    await workflow.tick(fixture);
    now = times(later).r1; await workflow.tick(later);
    now = times(fixture).r2 - 1; await workflow.tick(fixture);
    expect(provider.investigate).toHaveBeenCalledTimes(2);
    now++; await Promise.all([workflow.tick(fixture), workflow.tick(later)]);
    expect(store.read(later).status).toBe('researched');
    now = times(later).r2; await workflow.tick(later);
    now = times(fixture).submission; await Promise.all([workflow.tick(fixture), workflow.tick(later)]);
    expect(submission.submit).toHaveBeenCalledTimes(1);
    expect(submission.submit).toHaveBeenCalledWith(fixture, { home: 2, away: 1 }, expect.anything());
    expect(store.read(later).status).toBe('refreshed');
  });
  it('advances a healthy fixture through submission while another research session hangs', async () => {
    const other = { ...fixture, fixtureId: 'hung' };
    await workflow.tick(fixture); await workflow.tick(other);
    vi.useFakeTimers();
    const base = Date.now();
    clock = { now: () => times(fixture).r2 + Date.now() - base,
      sleep: (ms, signal) => bounded(ms + 1000, () => new Promise(resolve => setTimeout(resolve, ms)), signal) };
    const signals: AbortSignal[] = [];
    workflow = new Workflow(store, f => f.fixtureId === 'hung' ? {
      ...fakeResearch(), investigate: async (_, _tools, signal) => { signals.push(signal); return new Promise(() => {}); },
    } : fakeResearch(), predictor(), submission, clock, { research: { deadlineMs: 60 * MINUTE } });
    const stop = new AbortController();
    const running = workflow.run([other, fixture], stop.signal);
    await vi.advanceTimersByTimeAsync(40 * MINUTE + 100);
    expect(store.read(fixture).status).toBe('submitted');
    expect(store.read(other).attempt).toBe('r2');
    expect(submission.submit).toHaveBeenCalledTimes(1);
    stop.abort(); await running;
    expect(signals[0].aborted).toBe(true);
    expect(store.read(other).r2?.retryable).toBe(true);
    expect(store.read(other).status).toBe('researched');
  });
  it('contains a session startup error to its fixture while the other scheduler finishes', async () => {
    const broken = { ...fixture, fixtureId: 'broken' };
    workflow = new Workflow(store, f => {
      if (f.fixtureId === 'broken') throw new Error('Session unavailable');
      return fakeResearch();
    }, predictor(), submission, clock);
    await expect(workflow.run([broken, fixture], new AbortController().signal)).rejects.toThrow('Isolated fixture failures');
    expect(store.read(fixture).status).toBe('submitted');
    expect(store.read(broken).status).toBe('scheduled');
    expect(submission.submit).toHaveBeenCalledTimes(1);
  });
  it('rejects reuse of a provider session between fixtures', async () => {
    workflow = new Workflow(store, () => provider, predictor(), submission, clock);
    await workflow.tick(fixture);
    await expect(workflow.tick({ ...fixture, fixtureId: 'other' })).rejects.toThrow('Research session reused');
    expect(store.read(fixture).status).toBe('researched');
  });
  it('passes phase prompts and only the current R1 baseline; prediction still receives dossier only', async () => {
    const prediction = predictor();
    workflow = new Workflow(store, () => ({ ...provider }), prediction, submission, clock);
    const other = { ...fixture, fixtureId: 'other', home: 'Foreign Home', away: 'Foreign Away' };
    await workflow.tick(other);
    await workflow.tick(fixture);
    const r1 = store.read(fixture).r1!;
    now = times(fixture).r2;
    await workflow.tick(fixture);
    const calls = vi.mocked(provider.investigate).mock.calls;
    const first = calls[1][0];
    const second = calls[2][0];
    expect(first.prompt).toContain('Du bist der Research-Agent');
    expect(first.prompt).not.toContain('MATCH_DOSSIER_START');
    expect(second.prompt).toContain('Du bist der Research-2-Agent');
    expect(second.prompt).toContain(new Date(r1.completedAt).toISOString());
    expect(second.prompt).toContain('Home: checked team_form');
    expect(second.prompt).not.toContain('Foreign Home');
    expect(second.previous?.phase).toBe('r2');
    expect(Object.keys(second).sort()).toEqual(['categories', 'fixture', 'phase', 'previous', 'prompt']);
    expect(prediction.predict).not.toHaveBeenCalled();
    now = times(fixture).submission;
    await workflow.tick(fixture);
    expect(prediction.predict).toHaveBeenCalledExactlyOnceWith(dossier(store.read(fixture), true), expect.any(AbortSignal));
    expect(prediction.predict.mock.calls[0][0]).not.toContain('Du bist der Research');
    expect(JSON.stringify(store.read(fixture))).not.toContain('Du bist der Research');
  });
  it('runs simultaneous fixtures without sharing evidence or dossiers', async () => {
    const other = { ...fixture, fixtureId: 'other', home: 'Alpha', away: 'Beta' };
    await Promise.all([workflow.tick(fixture), workflow.tick(other)]);
    now = times(fixture).r2;
    await Promise.all([workflow.tick(fixture), workflow.tick(other)]);
    for (const [f, foreign] of [[fixture, other], [other, fixture]]) {
      const content = fs.readFileSync(store.files(f).dossier, 'utf8');
      expect(content).toContain(fixtureKey(f));
      expect(content).not.toContain(foreign.home);
      expect(store.read(f).r2?.evidence.every(e => e.url.includes(`/${f.fixtureId}/`))).toBe(true);
    }
  });
});

describe('durability, identity and recovery', () => {
  it.skipIf(process.platform !== 'linux')('restarts interrupted research after SIGKILL', async () => {
    const child = fork(new URL('./helpers/workflow-crash.mjs', import.meta.url), [root, JSON.stringify(fixture)], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    try {
      await once(child, 'message');
      await expect(workflow.tick(fixture)).rejects.toBeInstanceOf(LockUnavailableError);
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      expect(store.read(fixture).r1?.evidence).toHaveLength(1);
      expect(store.read(fixture).r1?.uncertainties).toContain('Crash checkpoint');
      await workflow.tick(fixture);
      expect(store.read(fixture).status).toBe('researched');
      expect(provider.investigate).toHaveBeenCalledTimes(1);
      expect(store.read(fixture).r1?.evidence.some(e => e.quote === 'Durable original')).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      }
    }
  });

  it('does not repeat completed research or submission after reopening the store', async () => {
    await ready(); now = times(fixture).submission; await workflow.tick(fixture);
    const restarted = new Workflow(new FileWorkflowStore(root), () => ({ ...provider }), predictor(), submission, clock);
    await restarted.tick(fixture);
    expect(provider.investigate).toHaveBeenCalledTimes(2);
    expect(submission.submit).toHaveBeenCalledTimes(1);
  });
  it('recovers an interrupted write by exact read only, including after kickoff', async () => {
    await ready();
    const prediction = await predictor().predict(dossier(store.read(fixture), true));
    await store.withFixture(fixture, async (s, save) => { s.prediction = prediction; s.attempt = 'submission'; s.submissionAttemptAt = times(fixture).submission; save(); saved = { fixture, score: s.prediction!.score }; });
    now = kickoff + 1;
    await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('submitted');
    expect(submission.submit).not.toHaveBeenCalled();
    expect(submission.read).toHaveBeenCalledTimes(1);
  });
  it('restarts an interrupted research stage', async () => {
    await store.withFixture(fixture, async (s, save) => { s.attempt = 'r1'; save(); });
    await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('researched');
    expect(provider.investigate).toHaveBeenCalledTimes(1);
    now = kickoff; await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('kickoff_passed');
  });
  it('retains research start intent if session creation fails and resumes after R2 becomes due', async () => {
    workflow = new Workflow(store, () => { throw new Error('Session process unavailable'); }, predictor(), submission, clock);
    await expect(workflow.tick(fixture)).rejects.toThrow('Session process unavailable');
    expect(store.read(fixture).r1?.startedAt).toBe(times(fixture).r1);
    now = times(fixture).r2;
    workflow = new Workflow(store, () => fakeResearch(), predictor(), submission, clock);
    await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('refreshed');
  });
  it('does not repeat research committed just before a process interruption', async () => {
    await workflow.tick(fixture);
    await store.withFixture(fixture, async (s, save) => { s.status = 'scheduled'; s.attempt = 'r1'; save(); });
    await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('researched');
    expect(provider.investigate).toHaveBeenCalledTimes(1);
  });
  it('excludes competing owners while permitting another fixture', async () => {
    const lock = FileLock.acquire(store.files(fixture).lock);
    try {
      await expect(workflow.tick(fixture)).rejects.toBeInstanceOf(LockUnavailableError);
      await workflow.tick({ ...fixture, fixtureId: 'other' });
    } finally { lock.release(); }
    await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('researched');
  });
  it('repairs Markdown from durable state and refuses changed kickoff or teams', async () => {
    await workflow.tick(fixture);
    fs.writeFileSync(store.files(fixture).dossier, 'interrupted projection');
    await workflow.tick(fixture);
    expect(fs.readFileSync(store.files(fixture).dossier, 'utf8')).toBe(dossier(store.read(fixture)));
    await expect(workflow.tick({ ...fixture, kickoff: kickoff + 1 })).rejects.toThrow(/identity/);
    await expect(workflow.tick({ ...fixture, home: 'Wrong' })).rejects.toThrow(/identity/);
  });
  it('persists long complete identity tuples without truncation', async () => {
    const f = { ...fixture, profile: 'p'.repeat(90), community: 'c'.repeat(90), season: 's'.repeat(90), competition: 't'.repeat(90), fixtureId: 'i'.repeat(90) };
    await workflow.tick(f);
    expect(store.read(f).r1?.fixtureKey).toBe(fixtureKey(f));
  });
  it('keeps delimiter-like IDs, seasons, accounts and competitions distinct', () => {
    const fixtures = [fixture, { ...fixture, fixtureId: '../42' }, { ...fixture, season: '2026_27' }, { ...fixture, profile: 'other' }, { ...fixture, competition: 'cup' }];
    expect(new Set(fixtures.map(fixtureKey)).size).toBe(fixtures.length);
    expect(new Set(fixtures.map(f => store.files(f).state)).size).toBe(fixtures.length);
    expect(fixtures.every(f => store.files(f).state.startsWith(root + path.sep))).toBe(true);
  });
});

describe('research freshness and read-back', () => {
  it('revalidates evidence before sending, even if persisted complete flags remain true', async () => {
    await ready();
    await store.withFixture(fixture, async (s, save) => { s.r2!.evidence[0].source.teams = ['Foreign']; save(); });
    now = times(fixture).submission; await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('submission_blocked');
    expect(submission.submit).not.toHaveBeenCalled();
  });
  it('blocks a well-formed prediction with an unresearched source', async () => {
    const p = predictor(); const predict = p.predict.getMockImplementation()!;
    p.predict.mockImplementation(async markdown => {
      const result = await predict(markdown);
      result.factors[0].sourceUrl = 'https://unopened.example/invented';
      return result;
    });
    workflow = new Workflow(store, () => ({ ...provider }), p, submission, clock);
    await workflow.tick(fixture); now = times(fixture).r2; await workflow.tick(fixture);
    expect(p.predict).not.toHaveBeenCalled();
    now = times(fixture).submission; await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('submission_blocked');
  });

  it.each(['r1', 'r2'] as const)('blocks stale %s before submission', async phase => {
    await ready();
    await store.withFixture(fixture, async (s, save) => { s[phase]!.startedAt = times(fixture)[phase] - 1; save(); });
    now = times(fixture).submission; await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('submission_blocked');
    expect(submission.submit).not.toHaveBeenCalled();
  });
  it('does not catch up a missed R1 at the R2 deadline', async () => {
    now = times(fixture).r2; await workflow.tick(fixture);
    expect(store.read(fixture).error).toBe('R1 window missed');
    expect(provider.investigate).not.toHaveBeenCalled();
  });
  it.each(['score', 'fixture', 'unavailable'] as const)('fails closed on %s read-back mismatch', async mismatch => {
    await ready();
    submission.read = vi.fn(async () => {
      if (mismatch === 'unavailable') throw new Error('offline');
      return { fixture: mismatch === 'fixture' ? { ...fixture, fixtureId: 'wrong' } : fixture,
        score: mismatch === 'fixture' ? { home: 2, away: 1 } : { home: 0, away: 0 } };
    });
    now = times(fixture).submission; await workflow.tick(fixture); await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('submission_failed');
    expect(submission.submit).toHaveBeenCalledTimes(1);
    now = kickoff; await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('kickoff_passed');
  });
  it('reads back even if submission threw after the server accepted it', async () => {
    submission.submit = vi.fn(async (f, score) => { saved = { fixture: f, score }; throw new Error('connection lost'); });
    await ready(); now = times(fixture).submission; await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('submitted');
  });
  it('rejects invented prediction sources and malformed probabilities', async () => {
    const p = predictor();
    p.predict.mockImplementation(async () => ({ fixtureKey: fixtureKey(fixture), probabilities: { home: 1, draw: 1, away: 1 } } as never));
    workflow = new Workflow(store, () => ({ ...provider }), p, submission, clock);
    await workflow.tick(fixture); now = times(fixture).r2; await workflow.tick(fixture);
    expect(p.predict).not.toHaveBeenCalled();
    now = times(fixture).submission; await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('submission_blocked');
    expect(submission.submit).not.toHaveBeenCalled();
  });
});

describe('original-source evidence and bounded research', () => {
  it('allows hundreds of distinct queries without an implicit call limit', async () => {
    const investigate = provider.investigate;
    provider.investigate = async (input, tools, signal) => {
      for (let i = 0; i < 150; i++) await tools.search(`new query ${i}`);
      return investigate(input, tools, signal);
    };
    expect((await research(fixture, 'r1', provider, () => now)).complete).toBe(true);
    expect(provider.search).toHaveBeenCalledTimes(150);
  });
  it('detects an unchanged repeated query and permits another strategy', async () => {
    const investigate = provider.investigate;
    provider.investigate = async (input, tools, signal) => {
      await tools.search('same');
      await expect(tools.search('same')).rejects.toThrow('No progress');
      await tools.search('different');
      return investigate(input, tools, signal);
    };
    const result = await research(fixture, 'r1', provider, () => now);
    expect(result.complete).toBe(true);
    expect(result.uncertainties.join(' ')).toContain('No progress');
  });
  it('persists partial coverage and predicts from the dossier with explicit gaps', async () => {
    const investigate = provider.investigate;
    provider.investigate = (input, tools, signal) =>
      investigate({ ...input, categories: input.categories.slice(0, 1) }, tools, signal);
    await ready();
    const state = store.read(fixture);
    expect(state.r2?.complete).toBe(true);
    expect(state.r2?.coverage).toContainEqual({ category: 'weather', team: 'Away', covered: false });
    expect(state.r2?.uncertainties).toContain('Missing research: weather / Away');
    expect(dossier(state)).toContain('weather / Away: missing');
    expect(submission.submit).not.toHaveBeenCalled();
    now = times(fixture).submission; await workflow.tick(fixture);
    expect(store.read(fixture).prediction).toBeDefined();
    expect(store.read(fixture).status).toBe('submitted');
  });
  it('requires research coverage for both teams', async () => {
    const open = provider.open;
    provider.open = async url => ({ ...await open(url), scope: 'team', teams: [fixture.home] });
    const r = await research(fixture, 'r1', provider, () => now);
    expect(r.complete).toBe(false);
    expect(r.uncertainties).toContain('Missing research: team_form / Away');
  });
  it('rejects a quote missing from the opened original and R1 categories in R2', async () => {
    const r1 = await research(fixture, 'r1', provider, () => now);
    const investigate = provider.investigate;
    provider.investigate = async (input, tools, signal) => {
      const report = await investigate(input, tools, signal) as { findings: Array<{ quote: string; category: string }> };
      report.findings[0].quote = 'Invented quote';
      report.findings[1].category = 'team_form';
      return report;
    };
    now = times(fixture).r2;
    const r = await research(fixture, 'r2', provider, () => now, { r1 });
    expect(r.complete).toBe(false);
    expect(r.rejected).toContain('confirmed_lineups: quote absent from original');
    expect(r.rejected).toContain('team_form: wrong phase category');
  });
  it('rejects stale or unverified R2 news', () => {
    now = times(fixture).r2;
    expect(evidenceGate(fixture, 'r2', { ...original(), publishedAt: now - 25 * 60 * MINUTE }, now)).toBe('stale source');
    expect(evidenceGate(fixture, 'r2', { ...original(), reliability: 'unchecked' }, now)).toBe('unverified source');
  });
  it('keeps cross-phase contradictions visible and marks older information superseded', async () => {
    await ready();
    await store.withFixture(fixture, async (s, save) => {
      s.r1!.evidence[0].subject = 'fitness'; s.r1!.evidence[0].claim = 'Available';
      s.r2!.evidence[0].subject = 'fitness'; s.r2!.evidence[0].claim = 'Unavailable'; save();
    });
    const content = fs.readFileSync(store.files(fixture).dossier, 'utf8');
    expect(content).toContain('superseded');
    expect(content).toContain('conflicting claims; uncertainty remains');
    expect(content).toContain('Available'); expect(content).toContain('Unavailable');
  });

  it('accepts a scoped team source without opponent text and a fully identified match source', () => {
    const source = original();
    expect(source.text).not.toContain(fixture.away);
    expect(evidenceGate(fixture, 'r1', source, now)).toBeUndefined();
    const match: Source = { ...source, scope: 'match', teams: [fixture.home, fixture.away], fixtureId: fixture.fixtureId, kickoff };
    expect(evidenceGate(fixture, 'r1', match, now)).toBeUndefined();
    expect(evidenceGate(fixture, 'r1', { ...match, fixtureId: 'other' }, now)).toBe('match identity');
  });
  it('rejects wrong season, competition, team, future or stale current news', () => {
    for (const change of [{ season: '2025/26' }, { competition: 'cup' }, { teams: ['Foreign'] }, { publishedAt: now + 1 }, { publishedAt: now - 8 * 24 * 60 * MINUTE }]) {
      expect(evidenceGate(fixture, 'r1', { ...original(), ...change }, now)).toBeDefined();
    }
    expect(evidenceGate(fixture, 'r1', { ...original(), kind: 'historical', publishedAt: now - 8 * 24 * 60 * MINUTE }, now)).toBeUndefined();
    now = times(fixture).r2;
    expect(evidenceGate(fixture, 'r2', { ...original(), kind: 'historical' }, now)).toBeDefined();
  });
  it('rejects unopened snippets and exposes incomplete coverage', async () => {
    provider.investigate = async () => ({ findings: [{ url: url(fixture, 'team_form'), category: 'team_form', team: fixture.home, subject: 'form', quote: 'snippet', claim: 'snippet' }], uncertainties: [] });
    const r = await research(fixture, 'r1', provider, () => now);
    expect(r.complete).toBe(false);
    expect(r.evidence).toEqual([]);
    expect(r.rejected).toContain('team_form: original not opened');
  });
  it('checkpoints opened originals and findings before a provider hangs, then resumes after restart', async () => {
    vi.useFakeTimers();
    provider.open = vi.fn(async () => original());
    provider.investigate = async (_, tools) => {
      const page = await tools.open(original().url);
      await tools.record({ findings: [{ url: page.url, category: 'team_form', team: fixture.home,
        subject: 'form', quote: page.text, claim: page.text }], uncertainties: ['Lineup unknown'] });
      return new Promise(() => {});
    };
    workflow = new Workflow(store, () => ({ ...provider }), predictor(), submission, clock, { research: { deadlineMs: 100 } });
    const pending = workflow.tick(fixture);
    await vi.advanceTimersByTimeAsync(20);
    expect(store.read(fixture).r1?.evidence).toHaveLength(1);
    expect(store.read(fixture).r1?.originals).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100); await pending;
    expect(store.read(fixture).status).toBe('scheduled');
    expect(store.read(fixture).r1?.retryable).toBe(true);
    now += 5 * MINUTE;
    let resumed = false;
    provider.investigate = async ({ previous }) => {
      resumed = previous?.evidence.length === 1;
      return { findings: [], uncertainties: ['Still no lineup'] };
    };
    const restarted = new Workflow(new FileWorkflowStore(root), () => ({ ...provider }), predictor(), submission, clock);
    await restarted.tick(fixture);
    expect(resumed).toBe(true);
    expect(store.read(fixture).status).toBe('researched');
    expect(store.read(fixture).r1?.evidence).toHaveLength(1);
  });
  it('resumes started R1 after the R2 boundary instead of permanently blocking the fixture', async () => {
    const stop = new AbortController();
    const investigate = provider.investigate;
    provider.investigate = async (input, tools, signal) => {
      const report = await investigate(input, tools, signal);
      await tools.record(report); stop.abort();
      return report;
    };
    await workflow.tick(fixture, stop.signal);
    expect(store.read(fixture).r1?.evidence.length).toBeGreaterThan(0);
    now = times(fixture).r2 + MINUTE;
    provider.investigate = investigate;
    await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('refreshed');
    expect(store.read(fixture).r2?.startedAt).toBeGreaterThanOrEqual(store.read(fixture).r1!.completedAt);
  });
  it('resumes more than 100 findings and retains distinct versions of one original', async () => {
    let revision = 0;
    provider.open = async () => ({ ...original(), text: `Original revision ${revision}` });
    provider.investigate = async (_, tools) => {
      for (revision = 0; revision < 110; revision++) {
        const page = await tools.open(original().url);
        await tools.record({ findings: [{ url: page.url, category: 'team_form', team: fixture.home,
          subject: `observation ${revision}`, quote: page.text, claim: page.text }], uncertainties: [] });
      }
      return { findings: [], uncertainties: [] };
    };
    const previous = await research(fixture, 'r1', provider, () => now);
    expect(previous.evidence).toHaveLength(110);
    provider.investigate = async () => ({ findings: [], uncertainties: [] });
    const resumed = await research(fixture, 'r1', provider, () => now, { previous });
    expect(resumed.complete).toBe(true);
    expect(resumed.evidence).toHaveLength(110);
    expect(resumed.evidence[0].quote).toBe('Original revision 0');
    expect(resumed.evidence[109].quote).toBe('Original revision 109');
  });
  it('times out an individual request while allowing another source', async () => {
    vi.useFakeTimers();
    const investigate = provider.investigate;
    provider.search = (_query, signal) => new Promise(() => { signal.addEventListener('abort', () => {}); });
    provider.investigate = async (input, tools, signal) => {
      await expect(tools.search('hung')).rejects.toThrow('deadline');
      return investigate(input, tools, signal);
    };
    const pending = research(fixture, 'r1', provider, () => now, { deadlineMs: 1000, requestTimeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).complete).toBe(true);
  });
  it('pauses on exhausted free quota without retry or fallback, preserving progress', async () => {
    provider.open = vi.fn(async () => original());
    provider.search = vi.fn(async () => { throw new ResearchPaused('quota_exhausted'); });
    provider.investigate = async (_, tools) => {
      const page = await tools.open(original().url);
      await tools.record({ findings: [{ url: page.url, category: 'team_form', team: fixture.home,
        subject: 'form', quote: page.text, claim: page.text }], uncertainties: [] });
      // Even a provider swallowing the error cannot turn quota exhaustion into success.
      try { await tools.search('another source'); } catch {}
      return { findings: [], uncertainties: [] };
    };
    const result = await research(fixture, 'r1', provider, () => now);
    expect(result.retryable).toBe(true);
    expect(result.evidence).toHaveLength(1);
    expect(result.uncertainties).toContain('Research paused: quota_exhausted');
    expect(provider.search).toHaveBeenCalledTimes(1);
  });
  it('abandons a repeated strategy and proceeds through other categories', async () => {
    const investigate = provider.investigate;
    provider.investigate = async (input, tools, signal) => {
      if (input.categories.length > 1 || input.categories[0] === 'team_form') {
        await tools.search('stuck');
        await tools.search('stuck');
      }
      return investigate(input, tools, signal);
    };
    const result = await research(fixture, 'r1', provider, () => now);
    expect(result.complete).toBe(true);
    expect(result.coverage).toContainEqual({ category: 'news', team: 'Away', covered: true });
    expect(result.coverage).toContainEqual({ category: 'team_form', team: 'Away', covered: false });
    expect(provider.search).toHaveBeenCalledTimes(2);
  });
  it('recognizes repeated unchanged originals', async () => {
    provider.open = vi.fn(async () => original());
    provider.investigate = async (_, tools) => {
      await tools.open(original().url);
      await expect(tools.open(original().url)).rejects.toThrow('No progress');
      return { findings: [], uncertainties: [] };
    };
    const result = await research(fixture, 'r1', provider, () => now);
    expect(result.uncertainties.join(' ')).toContain('No progress');
  });
  it('keeps the watchdog live during repeated immediate progress reports', async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockReturnValue(0);
    provider.open = vi.fn(async () => original());
    provider.investigate = async (_, tools) => {
      const page = await tools.open(original().url);
      const report = { findings: [{ url: page.url, category: 'team_form', team: fixture.home,
        subject: 'form', quote: page.text, claim: page.text }], uncertainties: [] };
      for (let i = 0; i < 100; i++) await tools.record(report);
      return report;
    };
    const pending = research(fixture, 'r1', provider, () => now, { deadlineMs: 20 });
    await vi.advanceTimersByTimeAsync(30);
    const result = await pending;
    expect(result.retryable).toBe(true);
    expect(result.evidence).toHaveLength(1);
  });
  it('allows at most one retry total', async () => {
    provider.open = vi.fn(async () => { throw new Error('unavailable'); });
    const r = await research(fixture, 'r1', provider, () => now);
    expect(provider.open).toHaveBeenCalledTimes(2);
    expect(r.complete).toBe(false);
  });
  it('recovers a single transient retrieval without repeating the research agent', async () => {
    const open = provider.open;
    provider.open = vi.fn().mockRejectedValueOnce(new Error('transient')).mockImplementation(open);
    const r = await research(fixture, 'r1', provider, () => now);
    expect(r.complete).toBe(true);
    expect(provider.investigate).toHaveBeenCalledTimes(1);
    expect(provider.open).toHaveBeenCalledTimes(categories.r1.length + 1);
  });
  it('enforces the aggregate tool budget', async () => {
    const r = await research(fixture, 'r1', provider, () => now, { deadlineMs: 1000, maxCalls: 2 });
    expect(provider.open).toHaveBeenCalledTimes(2);
    expect(r.complete).toBe(false);
  });
  it('has no default 60-second research deadline and can be explicitly aborted', async () => {
    vi.useFakeTimers();
    provider.investigate = () => new Promise(() => {});
    const stop = new AbortController();
    let finished = false;
    const pending = research(fixture, 'r1', provider, () => now, { signal: stop.signal })
      .then(result => { finished = true; return result; });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(finished).toBe(false);
    stop.abort();
    expect((await pending).retryable).toBe(true);
  });
  it('bounds a hung provider with a hard total deadline', async () => {
    vi.useFakeTimers();
    provider.investigate = () => new Promise(() => {});
    const pending = research(fixture, 'r1', provider, () => now, { deadlineMs: 50, maxCalls: 24 });
    await vi.advanceTimersByTimeAsync(51);
    expect((await pending).complete).toBe(false);
  });
  it('cancels late work and denies tools after timeout', async () => {
    vi.useFakeTimers();
    let captured: Parameters<ResearchProvider['investigate']>[1];
    provider.investigate = async (_, tools) => { captured = tools; return new Promise(() => {}); };
    const pending = research(fixture, 'r1', provider, () => now, { deadlineMs: 50, maxCalls: 24 });
    await vi.advanceTimersByTimeAsync(51); await pending;
    await expect(captured!.search('late')).rejects.toThrow('deadline');
    expect(provider.search).not.toHaveBeenCalled();
  });
  it('aborts successful bounded calls too, preventing leaked tool capabilities', async () => {
    let signal: AbortSignal;
    await bounded(1000, async s => { signal = s; return 1; });
    expect(signal!.aborted).toBe(true);
  });
});

describe('Hermes free Firecrawl configuration', () => {
  it('checks actual routing before requests and rejects quota exhaustion or a changed response backend', async () => {
    const web = JSON.parse(fs.readFileSync('docs/examples/hermes-firecrawl-free.example.json', 'utf8')).web;
    let mode = 'keyless';
    let backend = 'firecrawl';
    let status = 200;
    const request = vi.fn(async () => ({ backend, mode, status, data: [] }));
    const session = freeFirecrawlSession({
      policy: async () => ({ web, mode }),
      request,
    }, provider.investigate);
    const signal = new AbortController().signal;
    expect(await session.search('form', signal)).toEqual([]);
    mode = 'paid';
    await expect(session.search('form', signal)).rejects.toThrow('backend_changed');
    expect(request).toHaveBeenCalledTimes(1);
    mode = 'keyless'; status = 402;
    await expect(session.search('form', signal)).rejects.toThrow('quota_exhausted');
    status = 429;
    await expect(session.search('form', signal)).rejects.toThrow('rate_limited');
    status = 200; backend = 'parallel';
    await expect(session.search('form', signal)).rejects.toThrow('backend_changed');
  });
  it('validates the versioned example offline and rejects fallback or paid routing', () => {
    const script = path.resolve('scripts/check-hermes-firecrawl.py');
    const example = path.resolve('docs/examples/hermes-firecrawl-free.example.json');
    const run = (config: string) => execFileSync('python3', [script, '--config-only', config], { encoding: 'utf8', stdio: 'pipe' });
    expect(run(example)).toContain('config-only');
    const config = JSON.parse(fs.readFileSync(example, 'utf8'));
    const changed = path.join(root, 'config.json');
    for (const change of [{ keyless_fallback: true }, { search_backend: 'parallel' }, { use_gateway: true }]) {
      fs.writeFileSync(changed, JSON.stringify({ web: { ...config.web, ...change } }));
      expect(() => run(changed)).toThrow();
    }
  });
});


describe('review regressions', () => {
  it('cancels prediction before any new submission at an open window', async () => {
    const stop = new AbortController();
    const p = predictor();
    const predict = p.predict;
    p.predict = vi.fn(async (markdown: string) => {
      stop.abort();
      return predict(markdown);
    });
    workflow = new Workflow(store, () => ({ ...provider }), p, submission, clock);
    await workflow.tick(fixture);
    now = times(fixture).submission;
    await workflow.tick(fixture, stop.signal);
    expect(submission.submit).not.toHaveBeenCalled();
    expect(store.read(fixture).status).toBe('submission_blocked');
  });

  it('forwards cancellation to an active predictor that never resolves', async () => {
    const stop = new AbortController();
    let received: AbortSignal | undefined;
    workflow = new Workflow(store, () => ({ ...provider }), {
      predict: async (_, signal) => { received = signal; stop.abort(); return new Promise(() => {}); },
    }, submission, clock);
    await workflow.tick(fixture);
    now = times(fixture).submission;
    await workflow.tick(fixture, stop.signal);
    expect(received?.aborted).toBe(true);
    expect(submission.submit).not.toHaveBeenCalled();
  });

  it('cancels active submission but still reconciles an accepted write without retry', async () => {
    await ready();
    const stop = new AbortController();
    let received: AbortSignal | undefined;
    submission.submit = vi.fn(async (f, score, { signal }) => {
      received = signal; saved = { fixture: f, score }; stop.abort();
      return new Promise(() => {});
    });
    now = times(fixture).submission;
    await workflow.tick(fixture, stop.signal);
    expect(received?.aborted).toBe(true);
    expect(submission.read).toHaveBeenCalled();
    expect(store.read(fixture).status).toBe('submitted');
    await workflow.tick(fixture);
    expect(submission.submit).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('resumes corrected evidence after rejection (interruption=%s)', async interrupted => {
    const investigate = provider.investigate;
    provider.investigate = async (_, tools) => {
      await tools.record({ findings: [{ url: url(fixture, 'team_form'), category: 'team_form',
        team: fixture.home, subject: 'form', quote: 'unopened', claim: 'unopened' }], uncertainties: [] });
      if (interrupted) throw new Error('Interrupted after rejection');
      return { findings: [], uncertainties: [] };
    };
    await workflow.tick(fixture);
    expect(store.read(fixture).r1?.retryable).toBe(true);
    provider.investigate = investigate;
    now += 5 * MINUTE;
    await workflow.tick(fixture);
    const result = store.read(fixture);
    expect(result.status).toBe('researched');
    expect(result.r1?.rejected).toEqual([]);
    expect(result.r1?.evidence.some(e => e.quote === 'unopened')).toBe(false);
    expect(dossier(result)).toContain('Previously rejected: team_form: original not opened');
  });

  it('carries literal template syntax in R1 quotes through R2 and prediction', async () => {
    const open = provider.open;
    provider.open = async url => ({ ...await open(url), text: 'Quoted {{HOME_TEAM}} and }} are data' });
    await ready();
    expect(store.read(fixture).status).toBe('refreshed');
    expect(dossier(store.read(fixture))).toContain('Quoted {{HOME_TEAM}} and }} are data');
    now = times(fixture).submission; await workflow.tick(fixture);
    expect(store.read(fixture).prediction).toBeDefined();
    expect(store.read(fixture).status).toBe('submitted');
  });
});


it('upgrades legacy research identity only from a verified containing state', async () => {
  await ready();
  const state = store.read(fixture);
  delete state.r1!.fixture;
  delete state.r2!.fixture;
  fs.writeFileSync(store.files(fixture).state, JSON.stringify(state));
  expect(() => store.read({ ...fixture, kickoff: kickoff + 1000 })).toThrow('identity');
  expect(store.read(fixture).r1?.fixture).toEqual(fixture);
  now = times(fixture).submission;
  await workflow.tick(fixture);
  expect(store.read(fixture).status).toBe('submitted');
  expect(submission.submit).toHaveBeenCalledTimes(1);
});

it('rejects contradictory nested research identity instead of replacing it', async () => {
  await ready();
  const state = store.read(fixture);
  state.r1!.fixture = { ...fixture, home: 'Other' };
  fs.writeFileSync(store.files(fixture).state, JSON.stringify(state));
  expect(() => store.read(fixture)).toThrow('Research fixture identity');
  expect(submission.submit).not.toHaveBeenCalled();
});

it('rejects a same-key checkpoint with changed kickoff at the direct research boundary', async () => {
  const previous = await research(fixture, 'r1', provider, () => now);
  const unexpected: ResearchProvider = {
    search: async () => { throw new Error('Unexpected call'); },
    open: async () => { throw new Error('Unexpected call'); },
    investigate: vi.fn(async () => { throw new Error('Unexpected call'); }),
  };
  await expect(research({ ...fixture, kickoff: kickoff + 1000 }, 'r1', unexpected, () => now, { previous }))
    .rejects.toThrow('Checkpoint fixture identity');
  expect(unexpected.investigate).not.toHaveBeenCalled();
});


it('does not invoke queued bounded work after its parent has stopped', async () => {
  const stop = new AbortController();
  const work = vi.fn(async () => 'unexpected');
  const pending = bounded(1000, work, stop.signal);
  stop.abort();
  await expect(pending).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
});


describe('durable workflow notifications', () => {
  function capture() {
    const events: NotificationEvent[] = [];
    const send = vi.fn<Notifier['send']>(async event => {
      const durable = store.read(event.fixture);
      const queued = durable.notifications!.find(n => n.type === event.type && n.at === event.at);
      expect(queued?.delivery).toBe('attempted');
      if (event.type === 'r1_completed') expect(durable.r1?.complete).toBe(true);
      if (event.type === 'r2_completed') expect(durable.r2?.complete).toBe(true);
      if (event.type === 'tips_submitted') {
        expect(durable.status).toBe('submitted');
        expect(durable.confirmedAt).toBe(event.at);
        expect(submission.read).toHaveBeenCalled();
      }
      events.push(event);
    });
    return { events, send };
  }

  it('sends each success once after persistence across repeated ticks and restarts', async () => {
    const notifier = capture();
    const p = predictor();
    workflow = new Workflow(store, () => ({ ...provider }), p, submission, clock, { notifier });
    await workflow.tick(fixture); await workflow.tick(fixture);
    expect(notifier.events.map(e => e.type)).toEqual(['r1_completed']);
    now = times(fixture).r2;
    await workflow.tick(fixture); await workflow.tick(fixture);
    expect(notifier.events.map(e => e.type)).toEqual(['r1_completed', 'r2_completed']);
    expect(p.predict).not.toHaveBeenCalled();
    now = times(fixture).submission - 1;
    await workflow.tick(fixture);
    expect(p.predict).not.toHaveBeenCalled();
    now++;
    await workflow.tick(fixture); await workflow.tick(fixture);
    const restarted = new Workflow(new FileWorkflowStore(root), () => fakeResearch(), p, submission, clock, { notifier });
    await restarted.tick(fixture);
    expect(notifier.events.map(e => e.type)).toEqual(['r1_completed', 'r2_completed', 'tips_submitted']);
    expect(p.predict).toHaveBeenCalledTimes(1);
    expect(submission.submit).toHaveBeenCalledTimes(1);
    expect(store.read(fixture).notifications?.map(n => n.delivery)).toEqual(['sent', 'sent', 'sent']);
  });

  it('persists a failed notification without resetting successful research or retrying delivery', async () => {
    const notifier = { send: vi.fn<Notifier['send']>().mockRejectedValue(new Error('SECRET cookie private-url')) };
    workflow = new Workflow(store, () => fakeResearch(), predictor(), submission, clock, { notifier });
    await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('researched');
    expect(store.read(fixture).r1?.complete).toBe(true);
    expect(store.read(fixture).notifications?.[0].delivery).toBe('failed');
    expect(JSON.stringify(store.read(fixture))).not.toContain('SECRET');
    await workflow.tick(fixture);
    workflow = new Workflow(new FileWorkflowStore(root), () => fakeResearch(), predictor(), submission, clock, { notifier });
    await workflow.tick(fixture);
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  it('reports paused research with a safe phase event and no success', async () => {
    const notifier = capture();
    provider.investigate = async () => { throw new Error('SECRET provider https://private.example/?token=PRIVATE'); };
    workflow = new Workflow(store, () => ({ ...provider }), predictor(), submission, clock, { notifier });
    await workflow.tick(fixture); await workflow.tick(fixture);
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]).toEqual({ type: 'workflow_error', fixture, at: now, phase: 'r1' });
    expect(formatNotification(notifier.events[0])).not.toMatch(/SECRET|PRIVATE|https:/);
    expect(store.read(fixture).r1?.complete).toBe(false);
    expect(store.read(fixture).status).toBe('scheduled');
  });

  it('reports startup exceptions without copying raw provider details into the event', async () => {
    const notifier = capture();
    workflow = new Workflow(store, () => { throw new Error('SECRET provider startup'); }, predictor(), submission, clock, { notifier });
    await expect(workflow.tick(fixture)).rejects.toThrow('SECRET provider startup');
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0].type).toBe('workflow_error');
    expect(notifier.events[0].phase).toBe('r1');
    expect(JSON.stringify(notifier.events)).not.toContain('SECRET');
  });

  it('never announces successful submission after a read-back mismatch', async () => {
    const notifier = capture();
    workflow = new Workflow(store, () => ({ ...provider }), predictor(), submission, clock, { notifier });
    await ready();
    submission.read = vi.fn(async () => ({ fixture, score: { home: 0, away: 0 } }));
    now = times(fixture).submission;
    await workflow.tick(fixture); await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('submission_failed');
    expect(notifier.events.map(e => e.type)).toEqual(['r1_completed', 'r2_completed', 'workflow_error']);
    expect(notifier.events.at(-1)?.phase).toBe('submission');
    expect(submission.submit).toHaveBeenCalledTimes(1);
  });

  it('completes research-only scheduling without prediction or submission at an open window', async () => {
    const notifier = capture();
    const p = predictor();
    workflow = new Workflow(store, () => ({ ...provider }), p, submission, clock, { notifier, mode: 'research-only' });
    await workflow.run([fixture], new AbortController().signal);
    expect(store.read(fixture).status).toBe('refreshed');
    now = times(fixture).submission;
    await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('refreshed');
    expect(notifier.events.map(e => e.type)).toEqual(['r1_completed', 'r2_completed']);
    expect(p.predict).not.toHaveBeenCalled();
    expect(submission.submit).not.toHaveBeenCalled();
    expect(submission.read).not.toHaveBeenCalled();
  });
});


it('recovers an unsent success event after kickoff without another write', async () => {
  const send = vi.fn(async () => {});
  workflow = new Workflow(store, () => ({ ...provider }), predictor(), submission, clock, { notifier: { send } });
  await workflow.run([fixture], new AbortController().signal);
  await store.withFixture(fixture, async (s, save) => {
    s.notifications!.find(n => n.type === 'tips_submitted')!.delivery = 'pending'; save();
  });
  send.mockClear(); now = kickoff + 1;
  expect(store.recover()).toEqual([fixture]);
  await workflow.run(store.recover(), new AbortController().signal);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].type).toBe('tips_submitted');
  expect(submission.submit).toHaveBeenCalledTimes(1);
  expect(store.recover()).toEqual([]);
});

describe('explicit real submission test mode', () => {
  it.each([kickoff - 4 * 24 * 60 * MINUTE, times(fixture).r1, times(fixture).r2])('runs all phases immediately at %s, with real timestamps and one write', async at => {
    now = at;
    store = new FileWorkflowStore(root, 'test');
    const notices: NotificationEvent[] = [];
    workflow = new Workflow(store, () => fakeResearch(), predictor(), submission, clock, {
      testMode: true, notifier: { send: async event => { notices.push(event); } },
    });
    await workflow.tick(fixture);
    const state = store.read(fixture);
    expect(state.status).toBe('submitted');
    expect(state.execution).toBe('test');
    expect(state.fixture.kickoff).toBe(kickoff);
    expect(state.r1?.startedAt).toBe(at);
    expect(state.r2?.startedAt).toBe(at);
    expect(state.r1?.execution).toBe('test');
    expect(submission.submit).toHaveBeenCalledWith(fixture, { home: 2, away: 1 }, expect.objectContaining({ allowEarlySubmission: true }));
    expect(notices.map(n => n.type)).toEqual(['r1_completed', 'r2_completed', 'tips_submitted']);
    expect(notices.every(n => formatNotification(n).startsWith('[TEST]\n'))).toBe(true);
    await workflow.tick(fixture);
    expect(submission.submit).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(3);
    expect(() => new FileWorkflowStore(root).read(fixture)).toThrow('execution mode');
  });
  it('still forbids starting at kickoff', async () => {
    now = kickoff;
    store = new FileWorkflowStore(root, 'test');
    workflow = new Workflow(store, () => provider, predictor(), submission, clock, { testMode: true });
    await workflow.tick(fixture);
    expect(store.read(fixture).status).toBe('kickoff_passed');
    expect(provider.investigate).not.toHaveBeenCalled();
    expect(submission.submit).not.toHaveBeenCalled();
    expect(inSubmissionWindow(fixture, now, true)).toBe(false);
  });
  it('continues rejecting future, stale and wrong-fixture sources before T-5h', () => {
    now = kickoff - 4 * 24 * 60 * MINUTE;
    expect(evidenceGate(fixture, 'r2', original(), now, true)).toBeUndefined();
    expect(evidenceGate(fixture, 'r2', { ...original(), publishedAt: now + 1 }, now, true)).toBeDefined();
    expect(evidenceGate(fixture, 'r2', { ...original(), publishedAt: now - 25 * 60 * MINUTE }, now, true)).toBeDefined();
    expect(evidenceGate(fixture, 'r2', { ...original(), teams: ['Other'] }, now, true)).toBeDefined();
  });
});
