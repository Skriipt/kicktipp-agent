import { z } from 'zod';
import { fetchDashboardForm } from './dashboard.js';
import { placeBets } from '../core.js';
import type { ScopedKicktippClient } from '../client.js';

export const dashboardSlip = z.strictObject({
  matchday: z.number().int().min(1).max(99), season: z.string().regex(/^\d+$/),
  dry_run: z.boolean(), confirm: z.boolean(),
  edits: z.array(z.strictObject({ id: z.string().min(1).max(300), home: z.number().int().min(0).max(99), away: z.number().int().min(0).max(99), previous: z.string().regex(/^\d+:\d+$/).nullable() })).min(1).max(100),
});
export class SlipConflict extends Error {}
export type DashboardSlip = z.infer<typeof dashboardSlip>;

export async function submitDashboard(client: ScopedKicktippClient, slip: DashboardSlip) {
  if (!slip.dry_run && !slip.confirm) throw new SlipConflict('confirmation_required');
  return client.write(async (page, community) => {
    const form = await fetchDashboardForm(page, community, slip.matchday);
    if (form.season !== slip.season) throw new SlipConflict('season_changed');
    if (new Set(slip.edits.map(e => e.id)).size !== slip.edits.length) throw new SlipConflict('duplicate_match');
    const bets = slip.edits.map(edit => {
      const match = form.matches.find(m => m.id === edit.id);
      if (!match || !match.editable || !match.deadline || Date.parse(match.deadline) <= Date.now()) throw new SlipConflict('deadline_or_not_editable');
      if (match.bet !== edit.previous) throw new SlipConflict('bet_changed');
      return `${match.home} vs ${match.away}=${edit.home}:${edit.away}`;
    });
    let uncertain = false;
    try { await placeBets(page, community, bets, slip.matchday, !slip.dry_run, 'ha:place_bets'); }
    catch (error) { if (slip.dry_run) throw error; uncertain = true; }
    if (slip.dry_run) return { outcome: 'preview', matchday: slip.matchday, season: slip.season };
    // Never resubmit. A failed POST can still have persisted all or some values.
    try {
      const readback = await fetchDashboardForm(page, community, slip.matchday);
      if (readback.season !== slip.season) throw new Error('Season changed');
      const verification = slip.edits.map(e => ({ id: e.id, verified: readback.matches.find(m => m.id === e.id)?.bet === `${e.home}:${e.away}` }));
      return { outcome: verification.every(v => v.verified) ? 'verified' : uncertain ? 'submission_unknown' : 'not_verified', verification, form: readback };
    } catch {
      return { outcome: 'submission_unknown', matchday: slip.matchday, season: slip.season };
    }
  });
}
