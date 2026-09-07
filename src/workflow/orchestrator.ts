import { fixtureKey, fixtureSchema, sameFixture, type Fixture } from './model.js';
import { systemClock, type Clock } from './engine.js';
import type { ScheduleSource } from './mcp-schedule.js';

export interface FixtureRunner { run(fixtures: Fixture[], signal: AbortSignal): Promise<void> }
export interface OrchestratorOptions {
  pollMs?: number;
  clock?: Clock;
  recovered?: Fixture[];
  onError?: (reason: 'schedule_unavailable' | 'fixture_failed') => void;
}
/** Polling only imports schedules. Each running fixture owns its own precise wakeups. */
export async function orchestrate(source: ScheduleSource, workflow: FixtureRunner, signal: AbortSignal, options: OrchestratorOptions = {}): Promise<void> {
  const clock = options.clock ?? systemClock;
  const pollMs = options.pollMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 2_147_483_647) throw new Error('Invalid schedule interval');
  const known = new Map<string, Fixture>();
  const running = new Set<Promise<void>>();
  const controllers = new Map<string, AbortController>();
  const launch = (input: Fixture, recovered = false) => {
    const f = fixtureSchema.parse(input); const key = fixtureKey(f); const old = known.get(key);
    if (old) {
      if (!sameFixture(f, old)) {
        controllers.get(key)?.abort();
        throw new Error('Imported fixture identity changed');
      }
      return;
    }
    if (!recovered && clock.now() >= f.kickoff) return;
    known.set(key, f);
    const controller = new AbortController(); controllers.set(key, controller);
    const task = workflow.run([f], AbortSignal.any([signal, controller.signal])).catch(() => {
      known.delete(key); options.onError?.('fixture_failed');
    }).finally(() => { running.delete(task); controllers.delete(key); });
    running.add(task);
  };
  for (const f of options.recovered ?? []) launch(f, true);
  try {
    while (!signal.aborted) {
      try {
        const batch = await source.fetch(signal);
        const keys = batch.map(fixtureKey);
        if (new Set(keys).size !== keys.length) throw new Error('Duplicate schedule identities');
        for (const f of batch) {
          try { launch(f); } catch { options.onError?.('fixture_failed'); }
        }
      } catch { if (!signal.aborted) options.onError?.('schedule_unavailable'); }
      try { await clock.sleep(pollMs, signal); } catch { if (!signal.aborted) throw new Error('Schedule sleep failed'); }
    }
  } finally { await Promise.allSettled(running); }
}
