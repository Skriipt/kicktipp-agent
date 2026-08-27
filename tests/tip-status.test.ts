import { describe, expect, it } from 'vitest';
import { parseTipStatusHtml } from '../src/tip-status.js';

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
