import type { FetchLike } from '../browser.js';
import { createScopedClient } from '../client.js';
import type {
  ReminderCapability,
  ReminderCapabilityReason,
  ReminderSnapshot,
} from '../reminder-capability.js';
import { servicePaths, type ServicePaths } from './paths.js';
import {
  acquireServiceLock,
  readServiceConfiguration,
  readServiceState,
  type ServiceConfiguration,
} from './store.js';
import { targetRevision } from './targets.js';

type Stage = ServiceConfiguration['job']['policy']['stages'][number];

export interface ReminderPreview {
  outcome: 'disabled' | 'no-open-deadline-group' | 'not-due' | 'satisfied' | 'would-notify';
  job: {
    id: string;
    profileId: string;
    communityId: string;
  };
  deadlineGroup?: {
    deadlineAt: string;
    gameIds: string[];
  };
  stage?: Stage;
  skippedStages: Stage[];
  missingParticipants: Array<{ id: string; displayName: string }>;
  targets: Array<{ id: string; provider: ServiceConfiguration['targets'][number]['provider']; revision: string }>;
}

export type ReminderDryRunResult =
  | { reliable: true; preview: ReminderPreview }
  | { reliable: false; reason: ReminderCapabilityReason | 'snapshot-scope-mismatch' | 'invalid-snapshot' };

export function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (value) => value.codePointAt(0)!);
  const b = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function normalizedInstant(value: string): number | null {
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value
    ? instant.getTime()
    : null;
}

function validSnapshot(snapshot: ReminderSnapshot): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: snapshot.sourceTimeZone });
  } catch {
    return false;
  }

  const participantIds = new Set<string>();
  for (const participant of snapshot.participants) {
    if (!participant.id.trim() || !participant.displayName.trim() || participantIds.has(participant.id)) {
      return false;
    }
    participantIds.add(participant.id);
  }

  const gameIds = new Set<string>();
  for (const game of snapshot.games) {
    if (
      !game.id.trim() ||
      gameIds.has(game.id) ||
      normalizedInstant(game.deadlineAt) === null ||
      !['event', 'community-rule'].includes(game.deadlineSource)
    ) {
      return false;
    }
    gameIds.add(game.id);
  }
  if (gameIds.size === 0 || participantIds.size === 0) return false;

  const expected = participantIds.size * gameIds.size;
  const cells = new Set<string>();
  for (const cell of snapshot.cells) {
    const key = JSON.stringify([cell.participantId, cell.gameId]);
    if (
      !participantIds.has(cell.participantId) ||
      !gameIds.has(cell.gameId) ||
      !['predicted', 'missing'].includes(cell.status) ||
      cells.has(key)
    ) {
      return false;
    }
    cells.add(key);
  }
  return cells.size === expected;
}

function enabledTargets(configuration: ServiceConfiguration): ReminderPreview['targets'] {
  const referenced = new Set(configuration.job.targetIds);
  return configuration.targets
    .filter((target) => target.enabled && referenced.has(target.id))
    .map((target) => ({ id: target.id, provider: target.provider, revision: targetRevision(target) }));
}

export function evaluateReminderDryRun(
  configuration: ServiceConfiguration,
  capability: ReminderCapability,
  now = new Date(),
): ReminderDryRunResult {
  const job = {
    id: configuration.job.id,
    profileId: configuration.job.profileId,
    communityId: configuration.job.communityId,
  };
  const empty = {
    job,
    skippedStages: [],
    missingParticipants: [],
    targets: [],
  };
  if (!configuration.job.enabled) {
    return { reliable: true, preview: { outcome: 'disabled', ...empty } };
  }
  if (!capability.available) return { reliable: false, reason: capability.reason };
  const snapshot = capability.snapshot;
  if (snapshot.profileId !== job.profileId || snapshot.communityId !== job.communityId) {
    return { reliable: false, reason: 'snapshot-scope-mismatch' };
  }
  if (!validSnapshot(snapshot) || !Number.isFinite(now.getTime())) {
    return { reliable: false, reason: 'invalid-snapshot' };
  }

  const openGames = snapshot.games.filter(
    (game) => normalizedInstant(game.deadlineAt)! > now.getTime(),
  );
  if (openGames.length === 0) {
    return { reliable: true, preview: { outcome: 'no-open-deadline-group', ...empty } };
  }
  const deadlineAt = openGames.reduce(
    (earliest, game) => game.deadlineAt < earliest ? game.deadlineAt : earliest,
    openGames[0].deadlineAt,
  );
  const games = openGames.filter((game) => game.deadlineAt === deadlineAt);
  const deadlineGroup = {
    deadlineAt,
    gameIds: games.map(({ id }) => id).sort(compareCodePoints),
  };
  const crossed = [...configuration.job.policy.stages]
    .sort((a, b) => b.beforeDeadlineMinutes - a.beforeDeadlineMinutes)
    .filter(
      (stage) => now.getTime() >= normalizedInstant(deadlineAt)! - stage.beforeDeadlineMinutes * 60_000,
    );
  if (crossed.length === 0) {
    return {
      reliable: true,
      preview: { outcome: 'not-due', ...empty, deadlineGroup, targets: enabledTargets(configuration) },
    };
  }

  const stage = crossed.at(-1)!;
  const excluded = new Set(configuration.job.policy.excludeParticipantIds);
  const groupIds = new Set(deadlineGroup.gameIds);
  const missingIds = new Set(
    snapshot.cells
      .filter((cell) => groupIds.has(cell.gameId) && cell.status === 'missing')
      .map((cell) => cell.participantId),
  );
  const missingParticipants = snapshot.participants
    .filter((participant) => !excluded.has(participant.id) && missingIds.has(participant.id))
    .map((participant) => ({ ...participant, displayName: participant.displayName.normalize('NFC') }))
    .sort((a, b) => compareCodePoints(a.displayName, b.displayName) || compareCodePoints(a.id, b.id));

  return {
    reliable: true,
    preview: {
      outcome: missingParticipants.length ? 'would-notify' : 'satisfied',
      job,
      deadlineGroup,
      stage,
      skippedStages: crossed.slice(0, -1),
      missingParticipants,
      targets: enabledTargets(configuration),
    },
  };
}

export async function runReminderDryRun(options: {
  paths?: ServicePaths;
  now?: Date;
  fetchImpl?: FetchLike;
  getReminderCapability?: (profileId: string, communityId: string) => Promise<ReminderCapability>;
} = {}): Promise<ReminderDryRunResult> {
  const paths = options.paths ?? servicePaths();
  const lock = acquireServiceLock(paths);
  try {
    const configuration = readServiceConfiguration(paths);
    readServiceState(configuration, paths);
    if (!configuration.job.enabled) {
      return evaluateReminderDryRun(configuration, { available: false, reason: 'incomplete-matrix' }, options.now);
    }
    const capability = options.getReminderCapability
      ? await options.getReminderCapability(configuration.job.profileId, configuration.job.communityId)
      : await createScopedClient({
        profileId: configuration.job.profileId,
        communityId: configuration.job.communityId,
        fetchImpl: options.fetchImpl,
      }).getReminderSnapshot();
    return evaluateReminderDryRun(configuration, capability, options.now);
  } finally {
    lock.release();
  }
}
