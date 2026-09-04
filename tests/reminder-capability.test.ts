import fs from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createScopedClient } from '../src/client.js';
import { CookieJar } from '../src/http/cookie-jar.js';
import { Page } from '../src/http/page.js';
import {
  buildReminderCapability,
  fetchReminderCapability,
  parseAuthoritativeGameTimingsHtml,
  parseCommunityDeadlineRuleMinutes,
  sourceTimeZoneForKicktippUrl,
} from '../src/reminder-capability.js';
import {
  parseStablePredictionStatusHtml,
  parseTipStatusHtml,
} from '../src/tip-status.js';
import { setUrlBase } from '../src/url.js';
import { mockFetch, routes } from './helpers/mock-fetch.js';

const DE = fs.readFileSync(
  new URL('./fixtures/reminder-schedule-de.html', import.meta.url),
  'utf8',
);
const COM = fs.readFileSync(
  new URL('./fixtures/reminder-schedule-com.html', import.meta.url),
  'utf8',
);
const STATUS = fs.readFileSync(
  new URL('./fixtures/tip-status.html', import.meta.url),
  'utf8',
);

afterEach(() => setUrlBase('https://www.kicktipp.com'));

describe('authoritative Game timing', () => {
  it('normalizes explicit event Deadlines from both supported sites', () => {
    expect(
      parseAuthoritativeGameTimingsHtml(DE, 'Europe/Berlin'),
    ).toEqual({
      available: true,
      sourceTimeZone: 'Europe/Berlin',
      games: [
        {
          id: '7001',
          kickoffAt: '2026-08-28T18:30:00.000Z',
          deadlineAt: '2026-08-28T18:15:00.000Z',
          deadlineSource: 'event',
        },
        {
          id: '7002',
          kickoffAt: '2026-08-29T13:30:00.000Z',
          deadlineAt: '2026-08-29T13:00:00.000Z',
          deadlineSource: 'event',
        },
      ],
    });
    expect(
      parseAuthoritativeGameTimingsHtml(COM, 'America/Chicago'),
    ).toEqual({
      available: true,
      sourceTimeZone: 'America/Chicago',
      games: [
        {
          id: '7001',
          kickoffAt: '2026-08-28T18:30:00.000Z',
          deadlineAt: '2026-08-28T18:15:00.000Z',
          deadlineSource: 'event',
        },
        {
          id: '7002',
          kickoffAt: '2026-08-29T13:30:00.000Z',
          deadlineAt: '2026-08-29T13:00:00.000Z',
          deadlineSource: 'event',
        },
      ],
    });
  });

  it('uses kickoff only when a Community rule authoritatively derives the Deadline', () => {
    const withoutEventDeadlines = DE.replace(
      /<td class="deadline">[^<]*<\/td>/g,
      '<td class="deadline"></td>',
    );
    expect(parseAuthoritativeGameTimingsHtml(withoutEventDeadlines, 'Europe/Berlin')).toEqual({
      available: false,
      reason: 'missing-authoritative-deadline',
    });

    const derived = parseAuthoritativeGameTimingsHtml(
      withoutEventDeadlines,
      'Europe/Berlin',
      30,
    );
    expect(derived.available).toBe(true);
    if (!derived.available) return;
    expect(derived.games[0]).toMatchObject({
      deadlineAt: '2026-08-28T18:00:00.000Z',
      deadlineSource: 'community-rule',
    });

    const equal = parseAuthoritativeGameTimingsHtml(
      withoutEventDeadlines,
      'Europe/Berlin',
      0,
    );
    expect(equal.available && equal.games[0].deadlineAt).toBe(
      '2026-08-28T18:30:00.000Z',
    );
    expect(equal.available && equal.games[0].deadlineSource).toBe(
      'community-rule',
    );

    const kickoffOnly = DE
      .replace(/\s*<th name="tipptermin">[^<]*<\/th>/, '')
      .replace(/\s*<td class="deadline">[^<]*<\/td>/g, '');
    const fromKickoffOnly = parseAuthoritativeGameTimingsHtml(
      kickoffOnly,
      'Europe/Berlin',
      30,
    );
    expect(fromKickoffOnly.available).toBe(true);
    if (!fromKickoffOnly.available) return;
    expect(
      fromKickoffOnly.games.every(
        ({ deadlineSource }) => deadlineSource === 'community-rule',
      ),
    ).toBe(true);
  });

  it('recognizes only unambiguous numeric German and English Community rules', () => {
    expect(
      parseCommunityDeadlineRuleMinutes(
        '<h2>Tippabgaberegel: 15 Minuten Vorlaufzeit</h2>',
      ),
    ).toBe(15);
    expect(
      parseCommunityDeadlineRuleMinutes(
        '<h2>Prediction Rule: 30 minutes in advance</h2>',
      ),
    ).toBe(30);
    expect(
      parseCommunityDeadlineRuleMinutes(
        '<h2>Prediction Rule: special administrator setting</h2>',
      ),
    ).toBeNull();
    expect(
      parseAuthoritativeGameTimingsHtml(
        DE.replace(
          /<td class="deadline">[^<]*<\/td>/g,
          '<td class="deadline"></td>',
        ),
        'Europe/Berlin',
        -1,
      ),
    ).toEqual({ available: false, reason: 'missing-authoritative-deadline' });
  });

  it('keeps kickoff optional when the provider supplies event Deadlines', () => {
    const deadlineOnly = DE
      .replace(/\s*<th name="termin">[^<]*<\/th>/, '')
      .replace(/\s*<td class="kickoff">[^<]*<\/td>/g, '');
    const result = parseAuthoritativeGameTimingsHtml(
      deadlineOnly,
      'Europe/Berlin',
    );
    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.games[0]).toEqual({
      id: '7001',
      deadlineAt: '2026-08-28T18:15:00.000Z',
      deadlineSource: 'event',
    });
  });

  it('fails closed for unknown Source Time Zones and DST gaps or folds', () => {
    expect(parseAuthoritativeGameTimingsHtml(DE, null)).toEqual({
      available: false,
      reason: 'unknown-source-time-zone',
    });
    expect(parseAuthoritativeGameTimingsHtml(DE, 'Not/A_Zone')).toEqual({
      available: false,
      reason: 'unknown-source-time-zone',
    });

    const ambiguous = DE.replace('28.08.26 20:15', '25.10.26 02:30');
    expect(parseAuthoritativeGameTimingsHtml(ambiguous, 'Europe/Berlin')).toEqual({
      available: false,
      reason: 'ambiguous-local-timestamp',
    });
    const nonexistent = DE.replace('28.08.26 20:15', '29.03.26 02:30');
    expect(parseAuthoritativeGameTimingsHtml(nonexistent, 'Europe/Berlin')).toEqual({
      available: false,
      reason: 'nonexistent-local-timestamp',
    });

    const comAmbiguous = COM.replace('8/28/26 1:15 PM', '11/1/26 1:30 AM');
    expect(parseAuthoritativeGameTimingsHtml(comAmbiguous, 'America/Chicago')).toEqual({
      available: false,
      reason: 'ambiguous-local-timestamp',
    });
    const comNonexistent = COM.replace('8/28/26 1:15 PM', '3/8/26 2:30 AM');
    expect(parseAuthoritativeGameTimingsHtml(comNonexistent, 'America/Chicago')).toEqual({
      available: false,
      reason: 'nonexistent-local-timestamp',
    });
  });

  it('derives known Source Time Zones only from supported Kicktipp sites', () => {
    expect(sourceTimeZoneForKicktippUrl('https://www.kicktipp.de/c/tippspielplan')).toBe(
      'Europe/Berlin',
    );
    expect(sourceTimeZoneForKicktippUrl('https://www.kicktipp.com/c/schedule')).toBe(
      'America/Chicago',
    );
    expect(sourceTimeZoneForKicktippUrl('https://kicktipp.example/c/schedule')).toBeNull();
  });
});

describe('Reminder Capability', () => {
  it('exposes one complete scoped Reminder Snapshot', () => {
    const capability = buildReminderCapability(
      'family-profile',
      'community',
      parseAuthoritativeGameTimingsHtml(DE, 'Europe/Berlin'),
      parseStablePredictionStatusHtml(STATUS),
    );
    expect(capability.available).toBe(true);
    if (!capability.available) return;
    expect(capability.snapshot).toMatchObject({
      profileId: 'family-profile',
      communityId: 'community',
      sourceTimeZone: 'Europe/Berlin',
    });
    expect(capability.snapshot.participants.map(({ id }) => id)).toEqual([
      '9002',
      '9001',
    ]);
    expect(capability.snapshot.games.map(({ id }) => id)).toEqual(['7001', '7002']);
    expect(capability.snapshot.cells).toHaveLength(4);
  });

  it('rejects mismatched Games and incomplete Participant–Game rectangles', () => {
    const timings = parseAuthoritativeGameTimingsHtml(DE, 'Europe/Berlin');
    const predictions = parseStablePredictionStatusHtml(STATUS);
    expect(predictions.available).toBe(true);
    if (!predictions.available) return;

    expect(
      buildReminderCapability('p', 'c', timings, {
        ...predictions,
        games: predictions.games.slice(0, 1),
        cells: predictions.cells.filter(({ gameId }) => gameId === '7001'),
      }),
    ).toEqual({ available: false, reason: 'incomplete-games' });
    expect(
      buildReminderCapability('p', 'c', timings, {
        ...predictions,
        cells: predictions.cells.slice(0, -1),
      }),
    ).toEqual({ available: false, reason: 'incomplete-matrix' });
  });

  it('keeps interactive aggregate reads available when Reminder Capability fails', () => {
    const unavailable = buildReminderCapability(
      'p',
      'c',
      { available: false, reason: 'missing-authoritative-deadline' },
      parseStablePredictionStatusHtml(STATUS),
    );
    expect(unavailable).toEqual({
      available: false,
      reason: 'missing-authoritative-deadline',
    });
    expect(parseTipStatusHtml(STATUS).players).toHaveLength(2);
  });

  it('fetches through an explicit scoped profile and Community', async () => {
    setUrlBase('https://www.kicktipp.de');
    const { fetchImpl, calls } = mockFetch(
      routes({
        'https://www.kicktipp.de/community/tippspielplan?spieltagIndex=4': {
          body: DE,
        },
        'https://www.kicktipp.de/community/tippuebersicht?spieltagIndex=4': {
          body: STATUS,
        },
      }),
    );
    const page = new Page(new CookieJar(), fetchImpl);
    const capability = await fetchReminderCapability(
      page,
      'service-profile',
      'community',
      4,
    );

    expect(capability.available && capability.snapshot.profileId).toBe(
      'service-profile',
    );
    expect(capability.available && capability.snapshot.communityId).toBe(
      'community',
    );
    expect(calls.map(({ url }) => url)).toEqual([
      'https://www.kicktipp.de/community/tippspielplan?spieltagIndex=4',
      'https://www.kicktipp.de/community/tippuebersicht?spieltagIndex=4',
    ]);
    expect(
      typeof createScopedClient({
        profileId: 'service-profile',
        communityId: 'community',
      }).getReminderSnapshot,
    ).toBe('function');
  });
});
