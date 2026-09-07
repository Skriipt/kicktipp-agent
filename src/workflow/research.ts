import { performance } from 'node:perf_hooks';
import { WorkflowProcessError } from './process.js';
import { findingProblem, evidenceGate } from './evidence.js';
export { evidenceGate, validResearch } from './evidence.js';
import { renderResearchPrompt } from './prompts.js';
import { z } from 'zod';
import { coverage, categories, findingSchema, fixtureKey, MINUTE, researchSchema, sameFixture, sourceSchema, type Evidence, type Fixture, type Phase, type Research, type Source } from './model.js';

export interface ResearchTools {
  search(query: string): Promise<string[]>;
  open(url: string): Promise<Source>;
  /** Persist validated findings as they arrive, before doing more research. */
  record(report: unknown): Promise<void>;
}
export interface ResearchProvider {
  /** Only URLs are exposed from search. open must fetch an original page and
   * derive its metadata from that page, not search snippets or caller hints. */
  search(query: string, signal: AbortSignal): Promise<string[]>;
  open(url: string, signal: AbortSignal): Promise<Source>;
  investigate(input: { fixture: Fixture; phase: Phase; prompt: string; categories: readonly string[]; previous?: Research }, tools: ResearchTools, signal: AbortSignal): Promise<unknown>;
}
const reportSchema = z.object({
  findings: z.array(findingSchema),
  uncertainties: z.array(z.string().min(1)),
}).strict();

/** Wall deadline also bounds providers that ignore cancellation. No caller may
 * commit their eventual result or perform another tool call after expiry. */
export async function bounded<T>(milliseconds: number, work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  if (milliseconds <= 0) throw new Error('deadline');
  parent?.throwIfAborted();
  const controller = new AbortController();
  let cancel: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        cancel = () => { controller.abort(); reject(new Error('aborted')); };
        parent?.addEventListener('abort', cancel, { once: true });
      }),
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return work(controller.signal);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, milliseconds);
      }),
    ]);
  } finally {
    if (cancel) parent?.removeEventListener('abort', cancel);
    clearTimeout(timer);
    controller.abort();
  }
}

export interface ResearchOptions {
  testMode?: boolean;
  /** Technical watchdog, not an evidence requirement. Default: 30 minutes. */
  deadlineMs?: number;
  requestTimeoutMs?: number;
  /** Explicit operator protection only; undefined means unlimited. */
  maxCalls?: number;
  signal?: AbortSignal;
  previous?: Research;
  /** Separate from the same-phase recovery checkpoint. */
  r1?: Research;
  checkpoint?: (result: Research) => void;
}

class NoProgress extends Error {}
export class ResearchPaused extends Error {
  constructor(readonly reason: 'quota_exhausted' | 'rate_limited' | 'backend_changed' | 'operator_limit') {
    super(reason);
  }
}

export async function research(
  f: Fixture, phase: Phase, provider: ResearchProvider, now: () => number,
  options: ResearchOptions = {},
): Promise<Research> {
  const testMode = options.testMode === true;
  const deadlineMs = options.deadlineMs ?? 30 * MINUTE;
  const requestMs = options.requestTimeoutMs ?? 2 * MINUTE;
  for (const value of [deadlineMs, requestMs]) {
    if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) throw new Error('Invalid research timeout');
  }
  if (options.maxCalls !== undefined && (!Number.isSafeInteger(options.maxCalls) || options.maxCalls < 1)) throw new Error('Invalid maxCalls');
  const previous = options.previous === undefined ? undefined : researchSchema.parse(options.previous);
  if (previous && (previous.execution !== (testMode ? 'test' : undefined) || previous.fixtureKey !== fixtureKey(f) || !sameFixture(f, previous.fixture) || previous.phase !== phase)) throw new Error('Checkpoint fixture identity');
  const startedAt = previous?.startedAt ?? now();
  // Render before checkpoints/provider calls: invalid contracts must fail closed.
  const prompt = renderResearchPrompt(f, phase, { researchTimestamp: now(), r1: options.r1, testMode });
  const result: Research = { ...(testMode ? { execution: 'test' as const } : {}), fixture: structuredClone(f), fixtureKey: fixtureKey(f), phase, startedAt, completedAt: now(),
    complete: false, retryable: true, evidence: [], originals: [], uncertainties: [...previous?.uncertainties ?? []], rejected: [],
    rejectionHistory: [...new Set([...previous?.rejectionHistory ?? [], ...previous?.rejected ?? []])] };
  const opened = new Map<string, { source: Source; observedAt: number }>();
  // Keep each quoted version intact; a later open of the same URL must not
  // rewrite provenance of earlier findings, including on crash recovery.
  for (const e of previous?.evidence ?? []) {
    const reason = findingProblem(f, phase, e, e, testMode)
      ?? (e.observedAt < startedAt || e.observedAt > now() ? 'checkpoint observation time' : undefined);
    if (reason) result.rejected.push(`checkpoint: ${reason}`);
    else {
      result.evidence.push(structuredClone(e));
      opened.set(e.source.url, { source: structuredClone(e.source), observedAt: e.observedAt });
    }
  }
  for (const page of previous?.originals ?? []) {
    if (!evidenceGate(f, phase, page.source, page.observedAt, testMode) && page.observedAt >= startedAt && page.observedAt <= now()) {
      opened.set(page.source.url, structuredClone(page));
    } else result.rejected.push('checkpoint: invalid original');
  }
  const seen = new Map<string, string>();
  const stalled = new Set<string>();
  let calls = 0;
  let retries = 0;
  let paused: ResearchPaused | undefined;
  const end = performance.now() + deadlineMs;
  const checkpoint = () => {
    result.rejected = [...new Set(result.rejected)];
    result.completedAt = now();
    result.originals = [...opened.values()].filter(page => !evidenceGate(f, phase, page.source, page.observedAt, testMode));
    result.coverage = coverage(f, result);
    const gaps = result.coverage.filter(c => !c.covered).map(c => `Missing research: ${c.category} / ${c.team}`);
    result.uncertainties = [...new Set([...result.uncertainties.filter(x => !x.startsWith('Missing research: ')), ...gaps])];
    options.checkpoint?.(structuredClone(result));
  };
  const record = (input: unknown) => {
    const report = reportSchema.parse(input);
    result.uncertainties.push(...report.uncertainties);
    for (const finding of report.findings) {
      const page = opened.get(finding.url);
      const reason = findingProblem(f, phase, finding, page, testMode);
      if (reason) result.rejected.push(`${finding.category}: ${reason}`);
      else {
        const evidence = { ...finding, ...structuredClone(page!) };
        if (!result.evidence.some(e => JSON.stringify(e) === JSON.stringify(evidence))) result.evidence.push(evidence);
      }
    }
    checkpoint();
  };
  checkpoint();
  try {
    await bounded(Math.min(deadlineMs, f.kickoff - now()), async signal => {
      const check = () => {
        if (signal.aborted || performance.now() >= end || now() >= f.kickoff) throw new Error('deadline');
        if (paused) throw paused;
      };
      const progress = <T>(key: string, value: T): T => {
        const fingerprint = JSON.stringify(value);
        if (seen.get(key) === fingerprint) {
          stalled.add(key);
          result.uncertainties.push('No progress: repeated retrieval; change query, source or category');
          checkpoint();
          throw new NoProgress('No progress: repeated retrieval; change query, source or category');
        }
        seen.set(key, fingerprint);
        return value;
      };
      const call = async <T>(key: string, operation: (requestSignal: AbortSignal) => Promise<T>): Promise<T> => {
        check();
        // Yield to watchdogs even when a provider repeatedly catches tool errors.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        check();
        if (stalled.has(key)) throw new NoProgress('No progress: choose another query or original');
        const attempt = async () => {
          check();
          if (options.maxCalls !== undefined && calls >= options.maxCalls) {
            paused = new ResearchPaused('operator_limit');
            result.uncertainties.push('Operator maxCalls reached; checkpoint and pause');
            throw paused;
          }
          calls++;
          const value = await bounded(requestMs, operation, signal);
          check();
          return value;
        };
        try { return await attempt(); } catch (error) {
          if (error instanceof ResearchPaused) { paused = error; throw error; }
          if (retries >= 1 || signal.aborted) { stalled.add(key); throw error; }
          retries++;
          try { return await attempt(); } catch (retryError) {
            if (retryError instanceof ResearchPaused) paused = retryError;
            stalled.add(key);
            throw retryError;
          }
        }
      };
      const tools: ResearchTools = {
        search: async query => progress('search:' + query.trim(), z.array(z.url()).max(100).parse(await call('search:' + query.trim(), s => provider.search(query, s)))),
        open: async url => {
          z.url().parse(url);
          const source = sourceSchema.parse(await call('open:' + url, s => provider.open(url, s)));
          check();
          if (source.url !== url) throw new Error('Original URL must match (resolve redirects before returning candidates)');
          progress('open:' + url, source);
          const page = { source: structuredClone(source), observedAt: now() };
          const rejection = evidenceGate(f, phase, source, page.observedAt, testMode);
          if (!rejection) { opened.set(url, page); checkpoint(); }
          else {
            // Keep invalid originals only in the local gate so returned claims
            // receive the precise rejection; never persist them as evidence.
            opened.set(url, page);
          }
          return structuredClone(source);
        },
        record: async report => {
          check();
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          check();
          record(report);
        },
      };
      const investigate = async (selected: readonly string[]) => {
        const report = await provider.investigate({ fixture: structuredClone(f), phase, prompt, categories: selected,
          previous: structuredClone(result) }, tools, signal);
        check();
        record(report);
      };
      try { await investigate(categories[phase]); } catch (error) {
        if (!(error instanceof NoProgress)) throw error;
        // An unhandled repetition abandons that strategy, not the whole phase.
        for (const category of categories[phase]) {
          if (coverage(f, result).filter(c => c.category === category).every(c => c.covered)) continue;
          try { await investigate([category]); } catch (categoryError) {
            if (!(categoryError instanceof NoProgress)) throw categoryError;
            result.uncertainties.push(`Unresolved strategy: ${category}`);
          }
        }
      }
      for (const e of result.evidence) {
        if (result.evidence.some(other => other !== e && other.team === e.team && other.subject === e.subject && other.claim !== e.claim)) {
          result.uncertainties.push(`Conflicting claims: ${e.team} / ${e.subject}; prefer newer reliable source, retain uncertainty.`);
        }
      }
      result.complete = result.evidence.length > 0 && result.rejected.length === 0;
      // A rejected report can be corrected in a fresh attempt; it never authorizes prediction.
      result.retryable = !result.complete;
    }, options.signal);
  } catch (error) {
    const reason = paused?.reason ?? (options.signal?.aborted ? 'aborted'
      : error instanceof WorkflowProcessError ? error.message
      : error instanceof z.ZodError ? 'provider_output_invalid'
      : error instanceof Error && ['deadline', 'aborted'].includes(error.message) ? error.message
      : 'provider_failure');
    result.uncertainties.push(`Research paused: ${reason}`);
    result.complete = false;
    result.retryable = true;
  }
  // Invalid originals remain rejected; only accepted provenance is checkpointed.
  for (const [url, page] of opened) if (evidenceGate(f, phase, page.source, page.observedAt, testMode)) opened.delete(url);
  checkpoint();
  return result;
}

export function predictionSources(evidence: Evidence[]): Set<string> {
  return new Set(evidence.map(e => e.url));
}
