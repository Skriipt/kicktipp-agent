import { describe, it, expect, vi } from 'vitest';
import { parseOverview, parseForm, DashboardCache } from '../src/ha/dashboard.js';
const nav=(day=6)=>`<div class="spieltagsauswahl"><div class="level0 active-true"><a href="/pool/tippuebersicht?tippsaisonId=12&spieltagIndex=${day}">${day}. Spieltag</a></div></div>`;
function overview(){return `${nav()}<div id="kicktipp-content"><div class="pagetitle">Tippübersicht • 6. Spieltag</div>
<table id="spielplanSpiele"><tbody><tr data-url="/pool/spiel?tippspielId=41"><td>25.10.26 15:30</td><td>Home A</td><td>Away B</td><td>0:0</td></tr></tbody></table>
<table id="ranking"><thead><tr><th class="position">Pos</th><th class="positionsdifferenz">+/-</th><th class="name">Name</th><th class="ereignis" data-index="0" data-live="false"><a href="/pool/spiel?tippspielId=41"><div class="headerbox">A</div><div class="headerbox">B</div><div class="headerbox"><span class="kicktipp-abpfiff">0:0</span></div></a></th><th class="spieltagspunkte" data-label="Spieltagspunkte">P</th><th class="bonus" data-label="Bonuspunkte">B</th><th class="siege" data-label="Spieltagssiege">S</th><th class="gesamtpunkte" data-label="Gesamtpunkte">G</th></tr></thead><tbody>${[['a','1.','One','nw t','2:1<sub class="p">3</sub>'],['b','1.','Two','nw f','1:0'],['c','3.','Three','nw','']].map(([id,rank,name,cls,tip])=>`<tr data-teilnehmer-id="${id}"><td class="position">${rank}</td><td class="position-icon-up">2</td><td><div class="mg_name">${name}</div></td><td class="ereignis ${cls}">${tip}</td><td>3</td><td>0</td><td>1,67</td><td>12</td></tr>`).join('')}</tbody></table></div>`;}
const form=`${nav(7)}<input name="spieltagIndex" value="7"><div id="kicktipp-content"><div class="pagetitle">Tippabgabe account</div><table id="tippabgabeSpiele"><tbody><tr><td>25.10.26 15:30</td><td>Home</td><td>Away</td><td><input id="spieltippForms_42_heimTipp" name="spieltippForms[42].heimTipp" value="0"><input id="spieltippForms_42_gastTipp" name="spieltippForms[42].gastTipp" value="0"></td></tr><tr><td></td><td>Other</td><td>Team</td><td class="nichttippbar">1:2</td></tr></tbody></table></div>`;
describe('complete dashboard source contract',()=>{
 it('preserves source order, ties, IDs, columns, individual points and decimal wins',()=>{const data=parseOverview(overview(),'Two');expect(data.matchday).toBe(6);expect(data.rows.map(r=>r.id)).toEqual(['a','b','c']);expect(data.rows.map(r=>r.cells[0].text)).toEqual(['1.','1.','3.']);expect(data.columns).toHaveLength(8);expect(data.columns[3]).toMatchObject({matchId:'41',home:'Home A',away:'Away B',kickoff:'2026-10-25T14:30:00.000Z'});expect(data.rows[0].cells[3]).toEqual({state:'visible',text:'2:1',points:'3'});expect(data.rows[1].cells[3]).toEqual({state:'visible',text:'1:0',points:'0'});expect(data.rows[0].cells[6].text).toBe('1,67');expect(data.rows[1].isCurrentPlayer).toBe(true);expect(data.rows[0].cells[1]).toEqual({text:'2',direction:'up'});});
 it('does not infer a bet or zero points from an empty cell',()=>{expect(parseOverview(overview()).rows[2].cells[3]).toEqual({state:'not_tipped',text:null,points:null});const future=overview().replace('kicktipp-abpfiff','not-finished');expect(parseOverview(future).rows[2].cells[3]).toEqual({state:'unpublished',text:null,points:null});expect(parseOverview(overview().replace('1:0</td>','<span class="icon-lock"></span></td>')).rows[1].cells[3].state).toBe('hidden');});
 it('resolves the actual form day from metadata, keeps zero and true editability, handles Berlin DST',()=>{const data=parseForm(form);expect(data.matchday).toBe(7);expect(data.matches[0]).toMatchObject({id:'["Home","Away"]',bet:'0:0',editable:true,deadline:'2026-10-25T14:30:00.000Z'});expect(data.matches[1]).toMatchObject({bet:'1:2',editable:false,deadline:'2026-10-25T14:30:00.000Z'});expect(parseForm(form.replaceAll('value="0"','')).matches[0].bet).toBe(null);expect(parseForm(form.replace(/<td><input id="spieltippForms[\s\S]*?<\/td>/, '<td class="nichttippbar">0:0</td>')).matches[0].id).toBe(data.matches[0].id);expect(parseForm(form.replace('value="0"','value="0" disabled')).matches[0].editable).toBe(false);});
 it('fails closed on missing context, mismatched day or missing columns instead of mixing matches',()=>{expect(()=>parseForm(form,8)).toThrow();expect(()=>parseOverview(overview().replace(nav(),'' ).replace('6. Spieltag',''))).toThrow();expect(()=>parseOverview(overview().replace('<td>1,67</td>',''))).toThrow();expect(parseOverview(overview().replaceAll('6','42')).matchday).toBe(42);});
 it('coalesces browsers, caches, invalidates and never stores failed reads',async()=>{const cache=new DashboardCache();let resolve:any;const fetcher=vi.fn(()=>new Promise(r=>resolve=r));const a=cache.read('a',fetcher,()=>10000),b=cache.read('a',fetcher,()=>10000);resolve(1);expect(await a).toBe(1);expect(await b).toBe(1);expect(fetcher).toHaveBeenCalledTimes(1);expect(await cache.read('a',fetcher,()=>10000)).toBe(1);cache.clear();await expect(cache.read('a',async()=>{throw Error('failure')},()=>10000)).rejects.toThrow();expect(await cache.read('a',async()=>2,()=>10000)).toBe(2);});
});

describe('review metadata from the selected source page',()=>{
 it('reads only offered days in the same season, excluding bonus and sort links',()=>{
  const links=`<div class="spieltagsauswahl">${[[1,'12',''],[6,'12',''],[42,'12',''],[7,'99',''],[8,'12','&bonus=true'],[9,'12','&sortBy=gesamtpunkte']].map(([day,season,extra])=>`<div class="level0"><a href="/pool/tippuebersicht?tippsaisonId=${season}&spieltagIndex=${day}${extra}">${day}. Spieltag</a></div>`).join('')}</div>`;
  const data=parseOverview(overview().replace(nav(),nav()+links));
  expect(data.availableMatchdays.map(d=>d.matchday)).toEqual([6,1,42]);expect(data.season).toBe('12');
  expect(parseForm(form).availableMatchdays).toEqual([{matchday:7,label:'7. Spieltag'}]);
 });
 it('uses official selected-day winner flags, including shared and own winners, never total rank or wins',()=>{
  const single=overview().replace('data-teilnehmer-id="c"','class="sptsieger" data-teilnehmer-id="c"');
  expect(parseOverview(single,'Three').rows.map(r=>r.matchdayAward)).toEqual([null,null,'winner']);
  const shared=parseOverview(single.replace('data-teilnehmer-id="b"','class="sptsieger" data-teilnehmer-id="b"'),'Three');
  expect(shared.rows.filter(r=>r.matchdayAward==='winner').map(r=>r.id)).toEqual(['b','c']);expect(shared.rows[2].isCurrentPlayer).toBe(true);
  expect(parseOverview(overview()).rows.every(r=>r.matchdayAward===null)).toBe(true);
 });
 it('marks source leaders provisionally while live and no winners before any evaluation',()=>{
  const flagged=overview().replace('data-teilnehmer-id="a"','class="sptsieger" data-teilnehmer-id="a"');
  const live=flagged.replace('kicktipp-abpfiff','in-progress').replace('data-live="false"','data-live="true"');
  expect(parseOverview(live).rows[0].matchdayAward).toBe('leading');
  expect(parseOverview(flagged.replace('kicktipp-abpfiff','not-started')).rows.every(r=>r.matchdayAward===null)).toBe(true);
 });
 it('preserves actual up/down/unchanged source deltas independently of points',()=>{
  const html=overview().replace('position-icon-up">2','position-icon-down">14').replace('position-icon-up">2','position-icon-gleich">');
  expect(parseOverview(html).rows.map(r=>r.cells[1])).toEqual([{text:'14',direction:'down'},{text:'0',direction:'same'},{text:'2',direction:'up'}]);
 });
});
