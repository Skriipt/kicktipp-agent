import { z } from 'zod';

const id = z.string().min(1).max(200).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value), 'Invalid identifier');
const pathId = id.refine(value => Buffer.byteLength(value) <= 100, 'Identifier exceeds filesystem limit');
const instant = z.number().int().nonnegative().max(8_640_000_000_000_000);
export const fixtureSchema = z.object({
  profile: pathId, community: pathId, season: pathId, competition: pathId, matchday: pathId,
  fixtureId: pathId, home: id, away: id, kickoff: instant,
}).strict().refine(f => f.home !== f.away, 'Teams must differ');
export type Fixture = z.infer<typeof fixtureSchema>;
// Length-delimited JSON tuple, never a team-name concatenation or truncated hash.
export function fixtureKey(f: Fixture): string {
  return JSON.stringify([f.profile, f.community, f.season, f.competition, f.matchday, f.fixtureId]);
}
/** Full immutable identity, including fields deliberately absent from the storage key. */
export function sameFixture(a: Fixture, b: Fixture | undefined): boolean {
  return !!b && fixtureKey(a) === fixtureKey(b)
    && a.home === b.home && a.away === b.away && a.kickoff === b.kickoff;
}
export const MINUTE = 60_000;
export function times(f: Fixture) {
  return { r1: f.kickoff - 300 * MINUTE, r2: f.kickoff - 90 * MINUTE, submission: f.kickoff - 50 * MINUTE };
}
export function inSubmissionWindow(f: Fixture, now: number, allowEarlySubmission = false): boolean {
  return (allowEarlySubmission || now >= times(f).submission) && now < f.kickoff;
}
export const categories = {
  r1: ['team_form', 'home_away_form', 'injuries_suspensions', 'expected_lineups', 'rest_days', 'tactics', 'motivation', 'statistics', 'market', 'news'],
  r2: ['confirmed_lineups', 'late_absences', 'rotation', 'coach_news', 'breaking_news', 'weather', 'availability'],
} as const;
export type Phase = keyof typeof categories;
export const sourceSchema = z.object({
  url: z.url(), text: z.string().min(1).max(200_000), publishedAt: instant,
  reliability: z.enum(['primary', 'reliable', 'unchecked']),
  scope: z.enum(['match', 'team']), season: id, competition: id,
  teams: z.array(id).min(1).max(2), fixtureId: id.optional(), kickoff: instant.optional(),
  kind: z.enum(['historical', 'current']),
}).strict();
export type Source = z.infer<typeof sourceSchema>;
export const findingSchema = z.object({
  url: z.url(), category: id, team: id, subject: id,
  quote: z.string().min(1).max(4000), claim: z.string().min(1).max(4000),
}).strict();
export type Finding = z.infer<typeof findingSchema>;
export const evidenceSchema = findingSchema.extend({ source: sourceSchema, observedAt: instant });
export type Evidence = z.infer<typeof evidenceSchema>;
export const researchSchema = z.object({
  execution: z.literal('test').optional(),
  // Optional only for reading legacy files; new research always records identity.
  fixture: fixtureSchema.optional(),
  rejectionHistory: z.array(z.string()).optional(),
  fixtureKey: z.string().min(1).max(2000), phase: z.enum(['r1', 'r2']), startedAt: instant, completedAt: instant,
  retryable: z.boolean().optional(),
  originals: z.array(z.object({ source: sourceSchema, observedAt: instant }).strict()).optional(),
  coverage: z.array(z.object({ category: id, team: id, covered: z.boolean() }).strict()).optional(),
  complete: z.boolean(), evidence: z.array(evidenceSchema),
  uncertainties: z.array(z.string()), rejected: z.array(z.string()),
}).strict();
export type Research = z.infer<typeof researchSchema>;
export const predictionSchema = z.object({
  fixtureKey: z.string().min(1).max(2000),
  probabilities: z.object({ home: z.number().min(0).max(1), draw: z.number().min(0).max(1), away: z.number().min(0).max(1) }).strict(),
  expectedGoals: z.object({ home: z.number().min(0).max(20), away: z.number().min(0).max(20) }).strict(),
  score: z.object({ home: z.number().int().min(0).max(20), away: z.number().int().min(0).max(20) }).strict(),
  confidence: z.number().min(0).max(1),
  factors: z.array(z.object({ reason: z.string().min(1), sourceUrl: z.url() }).strict()).min(1),
}).strict().refine(p => Math.abs(p.probabilities.home + p.probabilities.draw + p.probabilities.away - 1) < 0.000001, 'Probabilities must sum to one');
export type Prediction = z.infer<typeof predictionSchema>;
export const statusSchema = z.enum(['scheduled', 'researched', 'refreshed', 'predicted', 'waiting_for_submission_window', 'eligible_for_submission', 'submitted', 'submission_failed', 'submission_blocked', 'kickoff_passed']);
export const stateSchema = z.object({
  execution: z.literal('test').optional(),
  version: z.literal(1), fixture: fixtureSchema,
  times: z.object({ r1: z.number(), r2: z.number(), submission: z.number() }).strict(),
  status: statusSchema, r1: researchSchema.optional(), r2: researchSchema.optional(),
  prediction: predictionSchema.optional(),
  attempt: z.enum(['r1', 'r2', 'prediction', 'submission']).optional(),
  notifications: z.array(z.object({
    key: z.string(), type: z.enum(['r1_completed', 'r2_completed', 'tips_submitted', 'workflow_error']),
    at: instant, phase: z.enum(['r1', 'r2', 'prediction', 'submission']).optional(),
    delivery: z.enum(['pending', 'attempted', 'sent', 'failed']),
  }).strict()).optional(),
  researchRetryAt: instant.optional(),
  submissionAttemptAt: instant.optional(), confirmedAt: instant.optional(),
  error: z.string().optional(),
  history: z.array(z.object({ status: statusSchema, at: instant }).strict()),
}).strict();
export type State = z.infer<typeof stateSchema>;

export function freshResearch(s: State, now: number, testMode = false): boolean {
  const { r1, r2, fixture: f } = s;
  const t = times(f);
  return s.execution === (testMode ? 'test' : undefined) && !!r1?.complete && !!r2?.complete
    && r1.execution === s.execution && r2.execution === s.execution
    && r1.fixtureKey === fixtureKey(f) && r2.fixtureKey === fixtureKey(f)
    && r1.phase === 'r1' && r2.phase === 'r2'
    && (testMode || (r1.startedAt >= t.r1 && r1.startedAt < t.r2)) && r1.completedAt >= r1.startedAt && r1.completedAt < f.kickoff
    && (testMode || r2.startedAt >= t.r2) && r2.startedAt >= r1.completedAt
    && r2.completedAt >= r2.startedAt && r2.completedAt <= now
    && now - r2.startedAt <= 90 * MINUTE;
}

export function coverage(f: Fixture, r: Research) {
  return categories[r.phase].flatMap(category => [f.home, f.away].map(team => ({
    category, team, covered: r.evidence.some(e => e.category === category && e.team === team),
  })));
}

/** Visible projection of authoritative JSON, always one dossier per fixture. */
export function dossier(s: State, final = false): string {
  const f = s.fixture;
  const lines = [`# ${f.home} vs ${f.away}`, '', `Fixture: ${fixtureKey(f)}`, `Season: ${f.season} | Competition: ${f.competition} | Matchday: ${f.matchday}`, `Kickoff: ${new Date(f.kickoff).toISOString()}`, `Status: ${final ? 'refreshed' : s.status}`, ''];
  if (s.execution === 'test') lines.unshift('TEST RUN — T-X gates bypassed; original fixture and real timestamps retained.', '');
  if (final) lines.push('Prediction contract: Use only facts quoted in this dossier. Account for missing coverage and uncertainty in confidence and reasons. Do not browse or invent facts.', '');
  for (const phase of ['r1', 'r2'] as const) {
    const r = s[phase];
    lines.push(`## ${phase.toUpperCase()} (${r ? r.complete ? 'complete' : 'INCOMPLETE' : 'pending'})`);
    if (!r) continue;
    lines.push(`Started: ${new Date(r.startedAt).toISOString()} | Completed: ${new Date(r.completedAt).toISOString()}`);
    lines.push('### Coverage', ...coverage(f, r).map(c => `- ${c.category} / ${c.team}: ${c.covered ? 'covered' : 'missing'}`));
    for (const kind of ['historical', 'current'] as const) {
      lines.push(`### ${kind}`);
      for (const e of r.evidence.filter(e => e.source.kind === kind)) {
        const all = [...s.r1?.evidence ?? [], ...s.r2?.evidence ?? []];
        const conflict = all.some(other => other.source.kind === kind && other.team === e.team && other.subject === e.subject && other.claim !== e.claim);
        const newer = all.some(other =>
          other.source.kind === kind && other.team === e.team && other.subject === e.subject
          && other.source.publishedAt > e.source.publishedAt);
        lines.push(`- ${e.category} / ${e.team} / ${e.subject}${conflict ? ' [conflicting claims; uncertainty remains]' : ''}${newer ? ' [superseded; retain for conflict review]' : ''}: ${e.claim}`, `  Source: ${e.url} | Published: ${new Date(e.source.publishedAt).toISOString()} | Observed: ${new Date(e.observedAt).toISOString()}`, `  Quote: ${JSON.stringify(e.quote)}`);
      }
    }
    lines.push('### Uncertainty / conflicts', ...r.uncertainties.map(x => `- ${x}`), ...r.rejected.map(x => `- Rejected: ${x}`), ...(r.rejectionHistory ?? []).map(x => `- Previously rejected: ${x}`));
  }
  if (!final && s.prediction) lines.push('## Prediction', '```json', JSON.stringify(s.prediction, null, 2), '```');
  if (!final && s.error) lines.push(`Control: ${s.error}`);
  return lines.join('\n') + '\n';
}
