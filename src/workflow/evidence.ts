import { categories, fixtureKey, MINUTE, researchSchema, sameFixture, times, type Finding, type Fixture, type Phase, type Research, type Source } from './model.js';

/** Metadata is semantic provenance supplied by the original-page adapter.
 * Team sources need one exact canonical team, not the opponent/country text. */
export function evidenceGate(f: Fixture, phase: Phase, source: Source, observedAt: number, testMode = false): string | undefined {
  if (source.reliability === 'unchecked') return 'unverified source';
  if (source.season !== f.season || source.competition !== f.competition) return 'season/competition';
  if (!source.teams.every(team => team === f.home || team === f.away)) return 'team';
  if (source.scope === 'match' && (source.fixtureId !== f.fixtureId || source.kickoff !== f.kickoff
    || source.teams.length !== 2 || !source.teams.includes(f.home) || !source.teams.includes(f.away))) return 'match identity';
  if (source.scope === 'team' && source.teams.length !== 1) return 'team scope';
  if ((!testMode && observedAt < times(f)[phase]) || source.publishedAt > observedAt || observedAt >= f.kickoff) return 'future/after kickoff';
  if (phase === 'r2' && (source.kind !== 'current' || (!testMode && observedAt < times(f).r2))) return 'R2 current state';
  const age = observedAt - source.publishedAt;
  if (source.kind === 'current' && age > (phase === 'r2' ? 24 * 60 : 7 * 24 * 60) * MINUTE) return 'stale source';
  return undefined;
}

export function findingProblem(f: Fixture, phase: Phase, finding: Finding, page?: { source: Source; observedAt: number }, testMode = false): string | undefined {
  return !page ? 'original not opened' : evidenceGate(f, phase, page.source, page.observedAt, testMode)
    ?? (finding.url !== page.source.url ? 'original URL' : undefined)
    ?? (!categories[phase].some(c => c === finding.category) ? 'wrong phase category' : undefined)
    ?? (!page.source.teams.includes(finding.team) ? 'claim team' : undefined)
    ?? (!page.source.text.includes(finding.quote) ? 'quote absent from original' : undefined);
}

export function validResearch(f: Fixture, r: Research, testMode = false): boolean {
  const parsed = researchSchema.safeParse(r);
  if (!parsed.success || parsed.data.execution !== (testMode ? 'test' : undefined) || !sameFixture(f, parsed.data.fixture)) return false;
  return r.complete && r.fixtureKey === fixtureKey(f) && r.rejected.length === 0
    && r.evidence.every(e => e.observedAt >= r.startedAt && e.observedAt <= r.completedAt
      && e.url === e.source.url && e.source.text.includes(e.quote) && e.source.teams.includes(e.team)
      && categories[r.phase].some(category => category === e.category)
      && evidenceGate(f, r.phase, e.source, e.observedAt, testMode) === undefined)
    && r.evidence.length > 0;
}
