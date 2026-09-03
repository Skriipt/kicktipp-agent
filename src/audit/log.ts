import fs from 'fs';
import path from 'path';
import { dataDir } from '../cache/paths.js';

/** Where a submission came from, so the log can answer "who did this?". */
export type BetSource =
  | 'cli:bet'
  | 'cli:suggest'
  | 'cli:tui'
  | 'cli:admin'
  | 'mcp:place_bets'
  | 'mcp:place_bonus_bets'
  | 'mcp:place_bets_for_member'
  | 'unknown';

export interface AuditBet {
  fixture: string;
  bet: string;
  /** What was on the form before, so an overwrite can be undone. */
  previous: string | null;
}

export interface AuditRecord {
  at: string;
  source: BetSource;
  community: string;
  matchday: number | null;
  kind: 'match' | 'bonus';
  dryRun: boolean;
  bets: AuditBet[];
  outcome: 'submitted' | 'dry-run' | 'intent' | `failed:${string}`;
  /** Set when an admin placed these for somebody else. */
  onBehalfOf?: string;
}

export function auditFile(community: string): string {
  const safe = community.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(dataDir(), 'audit', `${safe}.jsonl`);
}

/**
 * Append one record. A failure here is reported once on stderr and then
 * ignored: an unwritable log must never stop a bet the user asked for.
 */
export function appendAudit(record: AuditRecord): void {
  try {
    const file = auditFile(record.community);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    // appendFileSync only applies mode when creating, so make sure an older
    // file is not left world-readable.
    fs.chmodSync(file, 0o600);
  } catch (err) {
    console.error(
      `Warning: could not write the bet log (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
}

type PendingAuditRecord = Omit<AuditRecord, 'outcome'>;

/** Record intent, failure, and success around one real submission. */
export async function submitAudited(
  record: PendingAuditRecord,
  submit: () => Promise<void>,
): Promise<void> {
  appendAudit({ ...record, outcome: 'intent' });
  try {
    await submit();
  } catch (err) {
    appendAudit({
      ...record,
      at: new Date().toISOString(),
      outcome: `failed:${err instanceof Error ? err.message : String(err)}`,
    });
    throw err;
  }
  appendAudit({ ...record, at: new Date().toISOString(), outcome: 'submitted' });
}

export function readAudit(community: string): AuditRecord[] {
  const file = auditFile(community);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as AuditRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is AuditRecord => r !== null);
}

/** Only these records can be restored through the signed-in user's bet form. */
export function isOwnMatchSubmission(record: AuditRecord): boolean {
  return record.outcome === 'submitted' && record.kind === 'match' && !record.onBehalfOf;
}

/**
 * The most recent successful match submission for the signed-in user,
 * which is what `log --undo` reverses. Bonus and Spielleiter submissions
 * need different forms and therefore cannot be restored through this path.
 */
export function lastSubmission(
  community: string,
  matchday?: number,
): AuditRecord | null {
  const records = readAudit(community).filter(
    (r) => isOwnMatchSubmission(r) && (matchday === undefined || r.matchday === matchday),
  );
  return records.length ? records[records.length - 1] : null;
}
