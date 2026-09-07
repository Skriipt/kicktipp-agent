import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { orchestrate } from '../src/workflow/orchestrator.js';
import { McpScheduleSource } from '../src/workflow/mcp-schedule.js';
import { runProcess } from '../src/workflow/process.js';
import type { Fixture } from '../src/workflow/model.js';

const f: Fixture = { profile: 'test', community: 'test', season: '2026/27', competition: 'league', fixtureId: '42', matchday: '3', home: 'Home', away: 'Away', kickoff: Date.UTC(2026, 8, 12, 18) };
const directories: string[] = [];
afterEach(() => { for (const p of directories.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });

it('imports new fixtures while earlier loops run and never restarts unchanged fixtures', async () => {
  const stop = new AbortController(); let polls = 0;
  const source = { fetch: vi.fn(async () => ++polls === 1 ? [f] : [f, { ...f, fixtureId: '43' }]) };
  const run = vi.fn(async (_: Fixture[], signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })));
  await orchestrate(source, { run }, stop.signal, { clock: { now: () => f.kickoff - 1000,
    sleep: async () => { if (polls === 3) stop.abort(); } }, pollMs: 1000 });
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls.map(c => c[0][0].fixtureId)).toEqual(['42', '43']);
});

it('recovers persisted fixtures even after kickoff and isolates schedule failure', async () => {
  const stop = new AbortController(); const run = vi.fn(async () => {}); const error = vi.fn();
  await orchestrate({ fetch: async () => { throw new Error('Private token never logged'); } }, { run }, stop.signal, {
    recovered: [f], onError: error, pollMs: 1000,
    clock: { now: () => f.kickoff + 1, sleep: async () => { stop.abort(); } },
  });
  expect(run).toHaveBeenCalledWith([f], expect.any(AbortSignal));
  expect(error).toHaveBeenCalledWith('schedule_unavailable');
});

it('does not launch duplicate identities within one imported batch', async () => {
  const stop = new AbortController(); const run = vi.fn(async () => {});
  await orchestrate({ fetch: async () => [f, f] }, { run }, stop.signal, {
    pollMs: 1000, clock: { now: () => 0, sleep: async () => { stop.abort(); } },
  });
  expect(run).not.toHaveBeenCalled();
});

it('MCP handshake uses the read-only server and validates its structured scope', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-mcp-test-')); directories.push(root);
  const file = path.join(root, 'server.mjs');
  fs.writeFileSync(file, `import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
 const m=JSON.parse(line); if(!m.id) continue;
 if(process.env.KICKTIPP_READ_ONLY!=='1') process.exit(2);
 const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'fake',version:'1'}}:
 {structuredContent:{data:{fixtures:[${JSON.stringify(f)}]}}};
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
}`);
  const scope = { profile: f.profile, community: f.community, season: f.season, competition: f.competition, providerSeasonId: '123' };
  expect(await new McpScheduleSource(scope, [3], file).fetch(new AbortController().signal)).toEqual([f]);
  await expect(new McpScheduleSource({ ...scope, community: 'foreign' }, [3], file).fetch(new AbortController().signal)).rejects.toThrow('scope');
});

it('runs processes without shell expansion and discards raw errors', async () => {
  const signal = new AbortController().signal;
  const literal = '$(touch /tmp/never-create-workflow)';
  expect(await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal], { signal })).toBe(literal);
  await expect(runProcess(process.execPath, ['-e', 'console.error("token=private");process.exit(1)'], { signal })).rejects.toThrow('Workflow process failed');
});

it('cancels a process group including its running grandchild', async () => {
  const stop = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});setInterval(()=>{},1000)'], { signal: stop.signal });
  setTimeout(() => stop.abort(), 100);
  await expect(pending).rejects.toThrow('cancelled');
});


it('preserves UTF-8 across split process-output chunks', async () => {
  expect(await runProcess(process.execPath, ['-e',
    'process.stdout.write(Buffer.from([0xc3]));setTimeout(()=>process.stdout.write(Buffer.from([0xb6])),10)'],
  { signal: new AbortController().signal })).toBe('ö');
});


it('stops a changed fixture while still importing unrelated new fixtures', async () => {
  const stop = new AbortController(); let polls = 0;
  const run = vi.fn(async (_: Fixture[], signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })));
  await orchestrate({ fetch: async () => ++polls === 1 ? [f] : [{ ...f, kickoff: f.kickoff + 1000 }, { ...f, fixtureId: 'new' }] }, { run }, stop.signal, {
    pollMs: 1000, clock: { now: () => 0, sleep: async () => {
      if (polls === 2) { expect(run.mock.calls[0][1].aborted).toBe(true); stop.abort(); }
    } },
  });
  expect(run.mock.calls.map(c => c[0][0].fixtureId)).toEqual(['42', 'new']);
});
