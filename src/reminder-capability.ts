import * as cheerio from 'cheerio';
import { AuthError } from './core.js';
import type { Page } from './http/page.js';
import {
  inheritPrintedDate,
  resolveMatchDateStrict,
  type StrictTimestampResolution,
} from './helpers/match-date.js';
import {
  parseStablePredictionStatusHtml,
  providerIdFromUrl,
  type ParticipantGamePredictionStatus,
  type StablePredictionParticipant,
  type StablePredictionStatus,
} from './tip-status.js';
import { getLeaderboardUrl, getRulesUrl, getScheduleUrl } from './url.js';

export type DeadlineSource = 'event' | 'community-rule';

export interface ReminderGame {
  id: string;
  deadlineAt: string;
  deadlineSource: DeadlineSource;
  kickoffAt?: string;
}

export interface ReminderSnapshot {
  profileId: string;
  communityId: string;
  sourceTimeZone: string;
  participants: StablePredictionParticipant[];
  games: ReminderGame[];
  cells: ParticipantGamePredictionStatus[];
}

export type ReminderCapabilityReason =
  | Exclude<StablePredictionStatus, { available: true }>['reason']
  | 'unknown-source-time-zone'
  | 'missing-authoritative-deadline'
  | 'ambiguous-local-timestamp'
  | 'nonexistent-local-timestamp'
  | 'incomplete-games';

export type ReminderCapability =
  | { available: true; snapshot: ReminderSnapshot }
  | { available: false; reason: ReminderCapabilityReason };

type TimingResult =
  | { available: true; sourceTimeZone: string; games: ReminderGame[] }
  | { available: false; reason: ReminderCapabilityReason };

function timestampFailure(
  result: Exclude<StrictTimestampResolution, { resolved: true }>,
): ReminderCapabilityReason {
  return result.reason === 'invalid-timestamp'
    ? 'missing-authoritative-deadline'
    : result.reason;
}

/** The server-rendered clocks are site-local, not machine-local. */
export function sourceTimeZoneForKicktippUrl(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'kicktipp.de' || host.endsWith('.kicktipp.de')) {
      return 'Europe/Berlin';
    }
    if (host === 'kicktipp.com' || host.endsWith('.kicktipp.com')) {
      return 'America/Chicago';
    }
  } catch {
    // The capability diagnostic below is deliberately safe and URL-free.
  }
  return null;
}

/** Parse only Kicktipp's two documented numeric per-Game lead-time rules. */
export function parseCommunityDeadlineRuleMinutes(html: string): number | null {
  const text = cheerio.load(html).root().text().replace(/\s+/g, ' ');
  const values = new Set<number>();
  for (const pattern of [
    /Tippabgaberegel:\s*(\d+)\s*Minuten?\s+Vorlaufzeit/gi,
    /Prediction Rule:\s*(\d+)\s*minutes?\s+in advance/gi,
  ]) {
    for (const match of text.matchAll(pattern)) {
      const minutes = Number(match[1]);
      if (Number.isSafeInteger(minutes)) values.add(minutes);
    }
  }
  return values.size === 1 ? Array.from(values)[0] : null;
}

function columnIndex($: cheerio.CheerioAPI, name: string): number {
  return $('#spiele thead th')
    .toArray()
    .findIndex((header) => ($(header).attr('name') ?? '').trim() === name);
}

/** Parse stable Games and their authoritative timing from the schedule page. */
export function parseAuthoritativeGameTimingsHtml(
  html: string,
  sourceTimeZone: string | null,
  communityRuleMinutes: number | null = null,
): TimingResult {
  if (!sourceTimeZone) {
    return { available: false, reason: 'unknown-source-time-zone' };
  }
  // Validate the named zone even when the page contains no parseable rows.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: sourceTimeZone }).format();
  } catch {
    return { available: false, reason: 'unknown-source-time-zone' };
  }

  const $ = cheerio.load(html);
  const kickoffIndex = columnIndex($, 'termin');
  const deadlineIndex = columnIndex($, 'tipptermin');
  const ruleMinutes =
    communityRuleMinutes !== null &&
    Number.isSafeInteger(communityRuleMinutes) &&
    communityRuleMinutes >= 0
      ? communityRuleMinutes
      : null;
  if (kickoffIndex < 0 && deadlineIndex < 0) {
    return { available: false, reason: 'incomplete-games' };
  }
  if (deadlineIndex < 0 && ruleMinutes === null) {
    return { available: false, reason: 'missing-authoritative-deadline' };
  }

  const games: ReminderGame[] = [];
  const seen = new Set<string>();
  let lastKickoff = '';
  let lastDeadline = '';
  for (const row of $('#spiele tbody tr').toArray()) {
    const cells = $(row).children('td');
    if (!cells.length) continue;
    const id = providerIdFromUrl($(row).attr('data-url'), 'tippspielId');
    if (
      !id ||
      seen.has(id) ||
      (kickoffIndex >= 0 && cells.length <= kickoffIndex) ||
      (deadlineIndex >= 0 && cells.length <= deadlineIndex)
    ) {
      return { available: false, reason: 'incomplete-games' };
    }

    const kickoffText =
      kickoffIndex < 0
        ? ''
        : inheritPrintedDate($(cells[kickoffIndex]).text(), lastKickoff);
    const explicitDeadlineText =
      deadlineIndex < 0
        ? ''
        : inheritPrintedDate($(cells[deadlineIndex]).text(), lastDeadline);
    if (kickoffText) lastKickoff = kickoffText;
    if (explicitDeadlineText) lastDeadline = explicitDeadlineText;

    const kickoff = kickoffText
      ? resolveMatchDateStrict(kickoffText, sourceTimeZone)
      : null;
    if (kickoff && !kickoff.resolved) {
      return { available: false, reason: timestampFailure(kickoff) };
    }

    let deadline: StrictTimestampResolution;
    let deadlineSource: DeadlineSource;
    if (explicitDeadlineText) {
      deadline = resolveMatchDateStrict(explicitDeadlineText, sourceTimeZone);
      deadlineSource = 'event';
    } else if (ruleMinutes !== null && kickoff?.resolved) {
      deadline = {
        resolved: true,
        instant: new Date(
          kickoff.instant.getTime() - ruleMinutes * 60_000,
        ),
      };
      deadlineSource = 'community-rule';
    } else {
      return { available: false, reason: 'missing-authoritative-deadline' };
    }
    if (!deadline.resolved) {
      return { available: false, reason: timestampFailure(deadline) };
    }

    seen.add(id);
    games.push({
      id,
      deadlineAt: deadline.instant.toISOString(),
      deadlineSource,
      ...(kickoff?.resolved ? { kickoffAt: kickoff.instant.toISOString() } : {}),
    });
  }
  return games.length
    ? { available: true, sourceTimeZone, games }
    : { available: false, reason: 'incomplete-games' };
}

export function buildReminderCapability(
  profileId: string,
  communityId: string,
  timings: TimingResult,
  predictions: StablePredictionStatus,
): ReminderCapability {
  if (!timings.available) return timings;
  if (!predictions.available) return predictions;

  const timingIds = new Set(timings.games.map(({ id }) => id));
  const predictionIds = new Set(predictions.games.map(({ id }) => id));
  if (
    timingIds.size !== timings.games.length ||
    predictionIds.size !== predictions.games.length ||
    timingIds.size !== predictionIds.size ||
    Array.from(timingIds).some((id) => !predictionIds.has(id))
  ) {
    return { available: false, reason: 'incomplete-games' };
  }

  const expectedCells = predictions.participants.length * timings.games.length;
  const cellKeys = new Set(
    predictions.cells.map(({ participantId, gameId }) =>
      JSON.stringify([participantId, gameId]),
    ),
  );
  if (
    predictions.cells.length !== expectedCells ||
    cellKeys.size !== expectedCells ||
    predictions.cells.some(
      ({ participantId, gameId }) =>
        !timingIds.has(gameId) ||
        !predictions.participants.some(({ id }) => id === participantId),
    )
  ) {
    return { available: false, reason: 'incomplete-matrix' };
  }

  return {
    available: true,
    snapshot: {
      profileId,
      communityId,
      sourceTimeZone: timings.sourceTimeZone,
      participants: predictions.participants,
      games: timings.games,
      cells: predictions.cells,
    },
  };
}

async function getHtml(page: Page, url: string): Promise<string> {
  await page.goto(url);
  if (page.isAuthRedirect()) throw new AuthError('Kicktipp session is not authenticated.');
  return page.content();
}

export async function fetchReminderCapability(
  page: Page,
  profileId: string,
  communityId: string,
  matchday?: number,
): Promise<ReminderCapability> {
  const scheduleHtml = await getHtml(page, getScheduleUrl(communityId, matchday));
  const sourceTimeZone = sourceTimeZoneForKicktippUrl(page.url());
  let timings = parseAuthoritativeGameTimingsHtml(scheduleHtml, sourceTimeZone);
  if (!timings.available && timings.reason === 'missing-authoritative-deadline') {
    const rulesHtml = await getHtml(page, getRulesUrl(communityId));
    timings = parseAuthoritativeGameTimingsHtml(
      scheduleHtml,
      sourceTimeZone,
      parseCommunityDeadlineRuleMinutes(rulesHtml),
    );
  }

  const predictionHtml = await getHtml(
    page,
    getLeaderboardUrl(communityId, matchday),
  );
  return buildReminderCapability(
    profileId,
    communityId,
    timings,
    parseStablePredictionStatusHtml(predictionHtml),
  );
}
