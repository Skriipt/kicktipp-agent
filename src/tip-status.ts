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

export function parseTipStatusHtml(html: string): TipStatusData {
  const $ = cheerio.load(html);
  const content = $('#kicktipp-content');
  const title = content.find('div.pagetitle').first().text().trim();
  const ranking = content.find('table#ranking').first();
  if (!ranking.length) return emptyTipStatus(title);

  const eventClasses: string[] = [];
  ranking
    .find('thead th.ereignis[data-spiel="true"]')
    .each((_, header) => {
      const eventClass = eventClassForHeader($, header);
      if (eventClass && !eventClasses.includes(eventClass)) {
        eventClasses.push(eventClass);
      }
    });

  if (!eventClasses.length) {
    ranking.find('thead th.ereignis[data-index]').each((_, header) => {
      const eventClass = eventClassForHeader($, header);
      if (eventClass && !eventClasses.includes(eventClass)) {
        eventClasses.push(eventClass);
      }
    });
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
