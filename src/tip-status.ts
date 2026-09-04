import type { Page } from './http/page.js';
import * as cheerio from 'cheerio';
import { getLeaderboardUrl } from './url.js';

export type TipStatusKind = 'complete' | 'partial' | 'missing';

export interface TipStatusPlayer {
  name: string;
  tipped: number;
  missing: number;
  total: number;
  status: TipStatusKind;
}

export interface TipStatusSummary {
  complete: number;
  partial: number;
  missing: number;
}

export interface TipStatusData {
  title: string;
  totalMatches: number;
  players: TipStatusPlayer[];
  summary: TipStatusSummary;
}

export type PredictionStatusKind = 'predicted' | 'missing';

export interface StablePredictionParticipant {
  id: string;
  displayName: string;
}

export interface StablePredictionGame {
  id: string;
}

export interface ParticipantGamePredictionStatus {
  participantId: string;
  gameId: string;
  status: PredictionStatusKind;
}

export type StablePredictionStatus =
  | {
      available: true;
      participants: StablePredictionParticipant[];
      games: StablePredictionGame[];
      cells: ParticipantGamePredictionStatus[];
    }
  | {
      available: false;
      reason:
        | 'missing-or-ambiguous-participant-id'
        | 'missing-or-ambiguous-game-id'
        | 'incomplete-matrix';
    };

function emptyTipStatus(title = ''): TipStatusData {
  return {
    title,
    totalMatches: 0,
    players: [],
    summary: { complete: 0, partial: 0, missing: 0 },
  };
}

function eventClassForHeader(
  $: cheerio.CheerioAPI,
  header: any,
): string | null {
  const classes = ($(header).attr('class') || '').split(/\s+/);
  const eventClass = classes.find((className) => /^ereignis\d+$/.test(className));
  if (eventClass) return eventClass;

  const index = $(header).attr('data-index');
  return index !== undefined ? `ereignis${index}` : null;
}

function eventHeaders(ranking: cheerio.Cheerio<any>): any[] {
  const gameHeaders = ranking
    .find('thead th.ereignis[data-spiel="true"]')
    .toArray();
  return gameHeaders.length
    ? gameHeaders
    : ranking.find('thead th.ereignis[data-index]').toArray();
}

export function providerIdFromUrl(
  value: string | undefined,
  parameter: string,
): string | null | undefined {
  if (!value) return undefined;
  try {
    const values = new URL(value, 'https://www.kicktipp.invalid').searchParams
      .getAll(parameter)
      .map((id) => id.trim());
    if (!values.length) return undefined;
    return values.length === 1 && values[0] ? values[0] : null;
  } catch {
    return null;
  }
}

function participantId(
  $: cheerio.CheerioAPI,
  row: any,
): string | null {
  const attributeId = ($(row).attr('data-teilnehmer-id') || '').trim();
  const url = $(row).attr('data-url');
  const urlId = providerIdFromUrl(url, 'rankingTeilnehmerId');
  if (urlId === null) return null;
  const ids = [attributeId, urlId].filter((id): id is string => !!id);
  return ids.length && ids.every((id) => id === ids[0]) ? ids[0] : null;
}

function gameIdForHeader(
  $: cheerio.CheerioAPI,
  header: any,
): string | null {
  const ids = $(header)
    .find('a[href]')
    .toArray()
    .map((link) => providerIdFromUrl($(link).attr('href'), 'tippspielId'));
  if (ids.some((id) => id === null)) return null;
  const found = ids.filter((id): id is string => !!id);
  return found.length && found.every((id) => id === found[0])
    ? found[0]
    : null;
}

/**
 * Parse the provider identities and complete Participant–Game status matrix.
 * Partial data is intentionally not returned because it is unsafe for Reminders.
 */
export function parseStablePredictionStatusHtml(
  html: string,
): StablePredictionStatus {
  const $ = cheerio.load(html);
  const ranking = $('#kicktipp-content table#ranking').first();
  if (!ranking.length) return { available: false, reason: 'incomplete-matrix' };

  const games: StablePredictionGame[] = [];
  const columns: Array<{ eventClass: string; gameId: string }> = [];
  const eventClasses = new Set<string>();
  const gameIds = new Set<string>();
  for (const header of eventHeaders(ranking)) {
    const eventClass = eventClassForHeader($, header);
    const gameId = gameIdForHeader($, header);
    if (
      !eventClass ||
      !/^ereignis\d+$/.test(eventClass) ||
      !gameId ||
      eventClasses.has(eventClass) ||
      gameIds.has(gameId)
    ) {
      return { available: false, reason: 'missing-or-ambiguous-game-id' };
    }
    eventClasses.add(eventClass);
    gameIds.add(gameId);
    games.push({ id: gameId });
    columns.push({ eventClass, gameId });
  }
  if (!games.length) return { available: false, reason: 'incomplete-matrix' };

  const participants: StablePredictionParticipant[] = [];
  const cells: ParticipantGamePredictionStatus[] = [];
  const participantIds = new Set<string>();
  const rows = ranking
    .find('tbody tr')
    .filter(
      (_, row) =>
        $(row).hasClass('teilnehmer') ||
        !!$(row).find('div.mg_name').first().text().trim(),
    )
    .toArray();
  if (!rows.length) return { available: false, reason: 'incomplete-matrix' };

  for (const row of rows) {
    const displayName = $(row).find('div.mg_name').first().text().trim();
    const id = participantId($, row);
    if (!displayName || !id || participantIds.has(id)) {
      return { available: false, reason: 'missing-or-ambiguous-participant-id' };
    }
    if ($(row).children('td.ereignis').length !== games.length) {
      return { available: false, reason: 'incomplete-matrix' };
    }

    participantIds.add(id);
    participants.push({ id, displayName });
    for (const column of columns) {
      const cell = $(row).children(`td.${column.eventClass}`);
      if (cell.length !== 1) {
        return { available: false, reason: 'incomplete-matrix' };
      }
      cells.push({
        participantId: id,
        gameId: column.gameId,
        status: cell.text().trim() ? 'predicted' : 'missing',
      });
    }
  }

  return { available: true, participants, games, cells };
}

export function parseTipStatusHtml(html: string): TipStatusData {
  const $ = cheerio.load(html);
  const content = $('#kicktipp-content');
  const title = content.find('div.pagetitle').first().text().trim();
  const ranking = content.find('table#ranking').first();
  if (!ranking.length) return emptyTipStatus(title);

  const eventClasses: string[] = [];
  for (const header of eventHeaders(ranking)) {
    const eventClass = eventClassForHeader($, header);
    if (eventClass && !eventClasses.includes(eventClass)) {
      eventClasses.push(eventClass);
    }
  }

  const totalMatches = eventClasses.length;
  if (!totalMatches) return emptyTipStatus(title);

  const players: TipStatusPlayer[] = [];
  const summary: TipStatusSummary = {
    complete: 0,
    partial: 0,
    missing: 0,
  };

  ranking.find('tbody tr').each((_, row) => {
    const name = $(row).find('div.mg_name').first().text().trim();
    if (!name) return;

    let tipped = 0;
    for (const eventClass of eventClasses) {
      if ($(row).find(`td.${eventClass}`).first().text().trim()) {
        tipped += 1;
      }
    }

    let status: TipStatusKind;
    if (tipped === totalMatches) status = 'complete';
    else if (tipped === 0) status = 'missing';
    else status = 'partial';

    players.push({
      name,
      tipped,
      missing: totalMatches - tipped,
      total: totalMatches,
      status,
    });
    summary[status] += 1;
  });

  return { title, totalMatches, players, summary };
}

export async function fetchTipStatus(
  page: Page,
  community: string,
  matchday?: number,
): Promise<TipStatusData> {
  await page.goto(getLeaderboardUrl(community, matchday));
  return parseTipStatusHtml(await page.content());
}

export async function fetchStablePredictionStatus(
  page: Page,
  community: string,
  matchday?: number,
): Promise<StablePredictionStatus> {
  await page.goto(getLeaderboardUrl(community, matchday));
  return parseStablePredictionStatusHtml(await page.content());
}
