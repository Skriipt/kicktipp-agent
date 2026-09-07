import type { Notifier, NotificationEvent } from './notifications.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { LockUnavailableError } from '../service/lock.js';
import { dossier, fixtureKey, fixtureSchema, freshResearch, inSubmissionWindow, predictionSchema, times, type Fixture, type Prediction, type State } from './model.js';
import { bounded, predictionSources, research, validResearch, type ResearchProvider, type ResearchOptions } from './research.js';
import type { WorkflowStore } from './store.js';

export interface Clock {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}
export const systemClock: Clock = {
  now: Date.now,
  sleep: async (ms, signal) => { await sleep(Math.min(ms, 2_147_483_647), undefined, { signal }); },
};
export interface Predictor {
  /** This boundary receives ONLY the final Markdown. No tools, URLs to fetch,
   * shared research session or fixture batch. Run a live agent without web tools. */
  predict(finalDossier: string, signal: AbortSignal): Promise<unknown>;
}
export interface SubmissionAdapter {
  /** Must send exactly this fixture, no bonus fields; never retry writes.
   * Recheck clock/window immediately before the actual transport send, after
   * any awaited navigation/auth, and honor signal. */
  submit(fixture: Fixture, score: Prediction['score'], context: { signal: AbortSignal; now: () => number; allowEarlySubmission?: boolean }): Promise<void>;
  /** Uncached original read, identified by complete fixture metadata. */
  read(fixture: Fixture, signal: AbortSignal): Promise<{ fixture: Fixture; score: Prediction['score'] } | null>;
}

function transition(s: State, status: State['status'], now: number, save: () => void) {
  s.status = status;
  s.history.push({ status, at: now });
  save();
}
function sanePrediction(s: State): boolean {
  const parsed = predictionSchema.safeParse(s.prediction);
  const urls = predictionSources([...s.r1?.evidence ?? [], ...s.r2?.evidence ?? []]);
  return parsed.success && parsed.data.fixtureKey === fixtureKey(s.fixture)
    && parsed.data.factors.every(factor => urls.has(factor.sourceUrl));
}
function researchReady(s: State, now: number, testMode = false): boolean {
  return freshResearch(s, now, testMode) && validResearch(s.fixture, s.r1!, testMode) && validResearch(s.fixture, s.r2!, testMode);
}
export function nextDue(s: State, now: number): number | undefined {
  if (s.status === 'submitted' || s.status === 'kickoff_passed') return undefined;
  if (now >= s.fixture.kickoff) return now;
  if (s.status === 'submission_blocked' || s.status === 'submission_failed') return s.fixture.kickoff;
  if (s.attempt) return now;
  if (s.researchRetryAt && now < s.researchRetryAt) return Math.min(s.researchRetryAt, s.fixture.kickoff);
  if (s.execution === 'test') return now;
  const t = times(s.fixture);
  if (s.status === 'scheduled') return Math.max(now, t.r1);
  if (s.status === 'researched') return Math.max(now, t.r2);
  if (s.status === 'refreshed') return Math.max(now, t.submission);
  if (s.status === 'waiting_for_submission_window') return Math.max(now, t.submission);
  return now;
}

export interface WorkflowOptions {
  testMode?: boolean;
  notifier?: Notifier;
  mode?: 'full' | 'research-only';
  research?: Pick<ResearchOptions, 'deadlineMs' | 'requestTimeoutMs' | 'maxCalls'>;
  retryDelayMs?: number;
}

export class Workflow {
  private readonly sessions = new WeakSet<ResearchProvider>();
  constructor(
    readonly store: WorkflowStore,
    private readonly createResearchSession: (fixture: Fixture) => ResearchProvider,
    private readonly predictor: Predictor,
    private readonly submission: SubmissionAdapter,
    readonly clock: Clock = systemClock,
    private readonly options: WorkflowOptions = {},
  ) {}

  private enqueue(s: State, type: NotificationEvent['type'], at: number, phase?: NotificationEvent['phase']): void {
    if (!this.options.notifier) return;
    const key = JSON.stringify([fixtureKey(s.fixture), type, at, phase]);
    s.notifications ??= [];
    if (!s.notifications.some(n => n.key === key)) s.notifications.push({ key, type, at, phase, delivery: 'pending' });
  }

  private async deliver(f: Fixture): Promise<void> {
    if (!this.options.notifier) return;
    try {
      await this.store.withFixture(f, async (s, save) => {
        for (const n of s.notifications ?? []) {
          if (n.delivery !== 'pending') continue;
          // Persist intent first: never resend an ambiguous delivery after a crash.
          n.delivery = 'attempted'; save();
          try {
            await bounded(10_000, signal => this.options.notifier!.send({
              type: n.type, fixture: structuredClone(f), at: n.at, phase: n.phase, ...(s.execution === 'test' ? { test: true } : {}),
            }, signal));
            n.delivery = 'sent';
          } catch { n.delivery = 'failed'; }
          save();
        }
      });
    } catch { /* Delivery/persistence failure must not reset the business state. */ }
  }

  async tick(input: Fixture, signal?: AbortSignal): Promise<void> {
    const f = fixtureSchema.parse(input);
    try { await this.advance(f, signal); }
    catch (error) {
      if (!(error instanceof LockUnavailableError) && this.options.notifier) {
        try {
          await this.store.withFixture(f, async (s, save) => {
            const phase = s.attempt;
            this.enqueue(s, 'workflow_error', phase === 'r1' || phase === 'r2'
              ? s[phase]?.startedAt ?? this.clock.now() : s.history.at(-1)?.at ?? this.clock.now(), phase);
            save();
          });
        } catch { /* No trustworthy durable fixture: do not send. */ }
      }
      throw error;
    } finally { await this.deliver(f); }
  }

  private async advance(input: Fixture, signal?: AbortSignal): Promise<void> {
    const f = fixtureSchema.parse(input);
    await this.store.withFixture(f, async (s, save) => {
      const testMode = this.options.testMode === true;
      if (s.execution !== (testMode ? 'test' : undefined)) throw new Error('Workflow execution mode mismatch');
      const now = () => this.clock.now();
      const move = (status: State['status']) => transition(s, status, now(), () => {
        if (status === 'researched') this.enqueue(s, 'r1_completed', s.r1!.completedAt, 'r1');
        if (status === 'refreshed') this.enqueue(s, 'r2_completed', s.r2!.completedAt, 'r2');
        if (status === 'submission_blocked') this.enqueue(s, 'workflow_error', now());
        save();
      });
      const block = (reason: string) => { s.error = reason; delete s.attempt; move('submission_blocked'); };
      if (s.status === 'submitted' || s.status === 'kickoff_passed') return;
      // Recovery is read-only even after kickoff. A confirmed prior write can
      // still be reconciled; no new write is permitted after kickoff.
      if (s.attempt === 'submission') { await this.readBack(s, save); return; }
      if (now() >= f.kickoff) { move('kickoff_passed'); return; }
      if (s.status === 'submission_blocked' || s.status === 'submission_failed') return;
      if (s.attempt === 'r1' || s.attempt === 'r2') {
        s[s.attempt]?.uncertainties.push('Interrupted process; research resumed from last durable checkpoint.');
        delete s.attempt; delete s.researchRetryAt; save();
      }
      if (s.researchRetryAt && now() < s.researchRetryAt) return;
      if (signal?.aborted) return;
      if (s.attempt) { block(`Interrupted ${s.attempt}; no automatic duplicate run`); return; }
      const executeResearch = async (phase: 'r1' | 'r2') => {
        if (s[phase]?.complete && validResearch(f, s[phase]!, testMode)) return true;
        s[phase] ??= { ...(testMode ? { execution: 'test' as const } : {}), fixture: structuredClone(f), fixtureKey: fixtureKey(f), phase, startedAt: now(), completedAt: now(),
          complete: false, retryable: true, evidence: [], uncertainties: [], rejected: [] };
        s.attempt = phase; save();
        const session = this.createResearchSession(structuredClone(f));
        if (this.sessions.has(session)) throw new Error('Research session reused across attempts or fixtures');
        this.sessions.add(session);
        s[phase] = await research(f, phase, session, now, {
          ...this.options.research, testMode, signal, previous: s[phase], r1: phase === 'r2' ? s.r1 : undefined,
          checkpoint: result => { s[phase] = result; save(); },
        });
        delete s.attempt;
        if (s[phase]?.retryable) {
          this.enqueue(s, 'workflow_error', s[phase]!.completedAt, phase);
          s.researchRetryAt = now() + (this.options.retryDelayMs ?? 5 * 60_000);
          save(); return false;
        }
        delete s.researchRetryAt;
        save(); return true;
      };
      const t = times(f);
      if (s.status === 'scheduled' && (testMode || now() >= t.r1)) {
        if (!testMode && now() >= t.r2 && !s.r1) { block('R1 window missed'); return; }
        if (!await executeResearch('r1')) return;
        if (now() >= f.kickoff) { move('kickoff_passed'); return; }
        if (!s.r1?.complete || (!testMode && s.r1.startedAt >= t.r2) || s.r1.completedAt >= f.kickoff) { block('R1 incomplete or stale'); return; }
        move('researched');
      }
      if (s.status === 'researched' && (testMode || now() >= t.r2)) {
        if (!s.r1?.complete || !validResearch(f, s.r1, testMode) || (!testMode && (s.r1.startedAt < t.r1 || s.r1.startedAt >= t.r2)) || s.r1.completedAt >= f.kickoff || s.r1.fixtureKey !== fixtureKey(f)) {
          block('R1 incomplete or stale'); return;
        }
        if (!await executeResearch('r2')) return;
        if (now() >= f.kickoff) { move('kickoff_passed'); return; }
        if (!researchReady(s, now(), testMode)) { block('R2 incomplete or stale'); return; }
        move('refreshed');
      }
      if (signal?.aborted || this.options.mode === 'research-only') return;
      if (s.status === 'refreshed' && !testMode && now() < t.submission) return;
      if (s.status === 'refreshed') {
        if (!researchReady(s, now(), testMode)) { block('Research stale'); return; }
        s.attempt = 'prediction'; save();
        try {
          s.prediction = predictionSchema.parse(await bounded(Math.min(30_000, f.kickoff - now()), predictionSignal => this.predictor.predict(dossier(s, true), predictionSignal), signal));
          if (!sanePrediction(s)) throw new Error('prediction');
        } catch { block('Prediction failed sanity check or deadline'); return; }
        delete s.attempt;
        if (now() >= f.kickoff) { move('kickoff_passed'); return; }
        move('predicted');
      }
      if (s.status === 'predicted') move('waiting_for_submission_window');
      if (s.status === 'waiting_for_submission_window' && inSubmissionWindow(f, now(), testMode)) move('eligible_for_submission');
      if (s.status !== 'eligible_for_submission') return;
      if (!inSubmissionWindow(f, now(), testMode) || !researchReady(s, now(), testMode) || !sanePrediction(s)) {
        if (now() >= f.kickoff) move('kickoff_passed');
        else block('Submission identity, research, prediction or window invalid');
        return;
      }
      if (signal?.aborted) return;
      s.attempt = 'submission'; s.submissionAttemptAt = now(); save();
      try {
        await bounded(Math.min(30_000, f.kickoff - now()), submissionSignal => {
          submissionSignal.throwIfAborted();
          if (!inSubmissionWindow(f, now(), testMode)) throw new Error('window closed');
          return this.submission.submit(structuredClone(f), structuredClone(s.prediction!.score), { signal: submissionSignal, now, ...(testMode ? { allowEarlySubmission: true } : {}) });
        }, signal);
      } catch {
        s.error = 'Submission outcome unknown; exact read-back required';
        save();
      }
      // Always read even when the write timed out or threw after acceptance.
      await this.readBack(s, save);
    });
  }

  private async readBack(s: State, save: () => void): Promise<void> {
    try {
      const receipt = await bounded(30_000, signal => this.submission.read(structuredClone(s.fixture), signal));
      if (!receipt || JSON.stringify(fixtureSchema.parse(receipt.fixture)) !== JSON.stringify(s.fixture)
        || !sanePrediction(s) || receipt.score.home !== s.prediction!.score.home || receipt.score.away !== s.prediction!.score.away) {
        throw new Error('mismatch');
      }
      delete s.attempt; delete s.error; s.confirmedAt = this.clock.now();
      this.enqueue(s, 'tips_submitted', s.confirmedAt, 'submission');
      transition(s, 'submitted', this.clock.now(), save);
    } catch {
      delete s.attempt;
      s.error = 'Read-back mismatch or unavailable; never automatically resubmit';
      this.enqueue(s, 'workflow_error', s.submissionAttemptAt ?? this.clock.now(), 'submission');
      transition(s, this.clock.now() >= s.fixture.kickoff ? 'kickoff_passed' : 'submission_failed', this.clock.now(), save);
    }
  }

  /** A fixed imported schedule. No AI polling and no cron installation.
   * Restart the loop with a new fixture list when importing a new schedule. */
  async run(fixtures: Fixture[], signal: AbortSignal): Promise<void> {
    const parsed = fixtures.map(f => fixtureSchema.parse(f));
    if (new Set(parsed.map(fixtureKey)).size !== parsed.length) throw new Error('Duplicate fixture identity');
    // Each fixture owns its scheduler, deadline, state and provider session.
    // A hung fixture cannot hold the next-stage wakeup of another fixture.
    const results = await Promise.allSettled(parsed.map(async f => {
      while (!signal.aborted) {
        let contended = false;
        try { await this.tick(f, signal); } catch (error) {
          if (error instanceof LockUnavailableError) contended = true;
          else throw error;
        }
        if (signal.aborted) return;
        if (this.options.mode === 'research-only' && this.store.read(f).r2?.complete) return;
        const now = this.clock.now();
        let at: number | undefined;
        try { at = nextDue(this.store.read(f), now); } catch (error) {
          if (contended && (error as NodeJS.ErrnoException).code === 'ENOENT') at = now + 1000;
          else throw error;
        }
        if (at === undefined) return;
        const delay = at - now;
        try {
          await this.clock.sleep(contended && delay <= 0 ? 1000 : Math.max(0, delay), signal);
        } catch (error) { if (!signal.aborted) throw error; }
      }
    }));
    const errors = results.flatMap((result, index) => result.status === 'rejected'
      ? [new Error(`Fixture ${fixtureKey(parsed[index])} failed`, { cause: result.reason })] : []);
    if (errors.length) throw new AggregateError(errors, 'Isolated fixture failures');
  }
}
