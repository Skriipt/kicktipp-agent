import fs from 'fs';
import { describe, expect, it } from 'vitest';
import {
  parseStablePredictionStatusHtml,
  parseTipStatusHtml,
} from '../src/tip-status.js';

const STABLE_HTML = fs.readFileSync(
  new URL('./fixtures/tip-status.html', import.meta.url),
  'utf8',
);

const HTML = `
  <div id="kicktipp-content">
    <div class="pagetitle">Tippübersicht • 1. Spieltag</div>
    <table id="ranking" class="tippuebersicht">
      <thead>
        <tr>
          <th class="name">Name</th>
          <th class="ereignis ereignis0" data-index="0" data-spiel="true"></th>
          <th class="ereignis ereignis1" data-index="1" data-spiel="true"></th>
          <th class="ereignis ereignis2" data-index="2" data-spiel="true"></th>
          <th class="spieltagspunkte">P</th>
        </tr>
      </thead>
      <tbody>
        <tr class="teilnehmer">
          <td><div class="mg_name">Alice</div></td>
          <td class="ereignis ereignis0">-:-</td>
          <td class="ereignis ereignis1">2:1<sub class="p">4</sub></td>
          <td class="ereignis ereignis2">-:-</td>
          <td class="spieltagspunkte">4</td>
        </tr>
        <tr class="teilnehmer">
          <td><div class="mg_name">Bob</div></td>
          <td class="ereignis ereignis0">-:-</td>
          <td class="ereignis ereignis1"></td>
          <td class="ereignis ereignis2"></td>
          <td class="spieltagspunkte">0</td>
        </tr>
        <tr class="teilnehmer">
          <td><div class="mg_name">Charlie</div></td>
          <td class="ereignis ereignis0"></td>
          <td class="ereignis ereignis1"></td>
          <td class="ereignis ereignis2"></td>
          <td class="spieltagspunkte">0</td>
        </tr>
      </tbody>
    </table>
  </div>
`;

describe('parseTipStatusHtml', () => {
  it('distinguishes complete, partial and missing predictions', () => {
    expect(parseTipStatusHtml(HTML)).toEqual({
      title: 'Tippübersicht • 1. Spieltag',
      totalMatches: 3,
      players: [
        {
          name: 'Alice',
          tipped: 3,
          missing: 0,
          total: 3,
          status: 'complete',
        },
        {
          name: 'Bob',
          tipped: 1,
          missing: 2,
          total: 3,
          status: 'partial',
        },
        {
          name: 'Charlie',
          tipped: 0,
          missing: 3,
          total: 3,
          status: 'missing',
        },
      ],
      summary: {
        complete: 1,
        partial: 1,
        missing: 1,
      },
    });
  });

  it('returns an empty result when no ranking is present', () => {
    expect(parseTipStatusHtml('<div id="kicktipp-content"></div>')).toEqual({
      title: '',
      totalMatches: 0,
      players: [],
      summary: { complete: 0, partial: 0, missing: 0 },
    });
  });
});

describe('parseStablePredictionStatusHtml', () => {
  it('maps duplicate display names by provider identity', () => {
    expect(parseStablePredictionStatusHtml(STABLE_HTML)).toEqual({
      available: true,
      participants: [
        { id: '9002', displayName: 'Alex' },
        { id: '9001', displayName: 'Alex' },
      ],
      games: [{ id: '7001' }, { id: '7002' }],
      cells: [
        { participantId: '9002', gameId: '7001', status: 'missing' },
        { participantId: '9002', gameId: '7002', status: 'predicted' },
        { participantId: '9001', gameId: '7001', status: 'predicted' },
        { participantId: '9001', gameId: '7002', status: 'missing' },
      ],
    });
  });

  it('keeps prediction ownership when participant rows are reordered', () => {
    const rows = STABLE_HTML.match(/<tr class="teilnehmer"[\s\S]*?<\/tr>/g) ?? [];
    const reordered = STABLE_HTML
      .replace(rows[0]!, '__FIRST_PARTICIPANT__')
      .replace(rows[1]!, rows[0]!)
      .replace('__FIRST_PARTICIPANT__', rows[1]!);
    const result = parseStablePredictionStatusHtml(reordered);

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.participants.map(({ id }) => id)).toEqual(['9001', '9002']);
    expect(result.cells.filter(({ participantId }) => participantId === '9002')).toEqual([
      { participantId: '9002', gameId: '7001', status: 'missing' },
      { participantId: '9002', gameId: '7002', status: 'predicted' },
    ]);
  });

  it('is unavailable when a provider identifier is missing or ambiguous', () => {
    const missingParticipantId = STABLE_HTML
      .replace(' data-teilnehmer-id="9002"', '')
      .replace('rankingTeilnehmerId=9002', 'participant=9002');
    expect(parseStablePredictionStatusHtml(missingParticipantId)).toEqual({
      available: false,
      reason: 'missing-or-ambiguous-participant-id',
    });

    const missingGameId = STABLE_HTML.replace('tippspielId=7002', 'game=7002');
    expect(parseStablePredictionStatusHtml(missingGameId)).toEqual({
      available: false,
      reason: 'missing-or-ambiguous-game-id',
    });

    const ambiguousParticipantId = STABLE_HTML.replace(
      'rankingTeilnehmerId=9002',
      'rankingTeilnehmerId=different',
    );
    expect(parseStablePredictionStatusHtml(ambiguousParticipantId)).toEqual({
      available: false,
      reason: 'missing-or-ambiguous-participant-id',
    });
  });

  it('is unavailable instead of treating an incomplete matrix cell as missing', () => {
    const incomplete = STABLE_HTML.replace(
      '<td class="ereignis ereignis1">-:-</td>',
      '',
    );
    expect(parseStablePredictionStatusHtml(incomplete)).toEqual({
      available: false,
      reason: 'incomplete-matrix',
    });
  });
});
