import { describe, it, expect, vi } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
const { fakeRequest, fakeLookup } = vi.hoisted(() => ({ fakeRequest: vi.fn(), fakeLookup: vi.fn() }));
vi.mock('node:https', async importOriginal => ({ ...await importOriginal<typeof import('node:https')>(), request: fakeRequest }));
vi.mock('node:dns/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:dns/promises')>(), lookup: fakeLookup }));
import { CodexResearchProvider, HermesPredictor, fetchOriginal, publicIPv4 } from '../src/workflow/agents.js';
import type { RunProcess } from '../src/workflow/process.js';
import type { Source } from '../src/workflow/model.js';
const source: Source = { url: 'https://example.com/article', text: 'Team A won.', publishedAt: 1000, reliability: 'reliable', scope: 'team', season: '2026', competition: 'League', teams: ['Team A'], kind: 'historical' };
const finding = { url: source.url, category: 'team_form', team: 'Team A', subject: 'form', quote: 'Team A won.', claim: 'Won' };
const fixture = { profile: 'p', community: 'c', season: '2026', competition: 'League', matchday: '1', fixtureId: '1', home: 'Team A', away: 'Team B', kickoff: 9999999 };
const signal = () => new AbortController().signal;
function runnerReturning(value: unknown, inspect?: RunProcess): RunProcess {
  return async (exe, args, options) => {
    await inspect?.(exe, args, options);
    await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(value));
    return '';
  };
}
describe('isolated live model adapters (fake processes only)', () => {
  it('preserves prompt, fixes model/tools, checkpoints only independently opened originals, and removes workspace', async () => {
    let cwd = '';
    const provider = new CodexResearchProvider({ runner: runnerReturning({ markdown: '# Report', originals: [source], findings: [finding], uncertainties: [] }, async (exe, args, options) => {
      cwd = options.cwd!;
      expect(exe).toBe('codex'); expect(args).toContain('--search'); expect(args).toContain('--ephemeral');
      expect(args).toContain('features.shell_tool=false'); expect(args).toContain('mcp_servers={}');
      expect(args).toContain('gpt-5.6-luna'); expect(options.input).toContain('FIXED PROMPT');
      expect(options.env?.CODEX_HOME).toBe(join(cwd, 'codex')); return '';
    }) });
    const recorded: unknown[] = [];
    const report = await provider.investigate({ fixture, phase: 'r1', prompt: 'FIXED PROMPT', categories: ['team_form'] }, {
      search: async () => [], open: async url => { expect(url).toBe(source.url); return source; }, record: async item => { recorded.push(item); },
    }, signal());
    expect(recorded).toEqual([{ findings: [finding], uncertainties: [] }]);
    expect(report).toEqual({ findings: [finding], uncertainties: [] });
    await expect(access(cwd)).rejects.toThrow();
  });
  it('rejects invented quotes and never checkpoints them', async () => {
    let records = 0;
    const provider = new CodexResearchProvider({ runner: runnerReturning({ markdown: '# Report', originals: [source], findings: [finding], uncertainties: [] }) });
    await expect(provider.investigate({ fixture, phase: 'r1', prompt: 'prompt', categories: [] }, { search: async () => [], open: async () => ({ ...source, text: 'Different original' }), record: async () => { records++; } }, signal())).rejects.toThrow('quote mismatch');
    expect(records).toBe(0);
  });
  it('derives metadata from fetched original only, never returns model-written source text', async () => {
    const { url: _url, text: _text, ...metadata } = source;
    const provider = new CodexResearchProvider({ fetch: async () => 'Actual fetched body', runner: runnerReturning(metadata, async (_exe, args, options) => {
      expect(args).not.toContain('--search'); expect(args).toContain('web_search="disabled"'); expect(options.input).toContain('Actual fetched body'); return '';
    }) });
    expect(await provider.open(source.url, signal())).toEqual({ ...source, text: 'Actual fetched body' });
  });
  it('cleans subprocess failures and respects pre-abort', async () => {
    let cwd = '';
    const provider = new CodexResearchProvider({ runner: async (_exe, _args, options) => { cwd = options.cwd!; throw new Error('failure'); } });
    await expect(provider.search('q', signal())).rejects.toThrow('failure'); await expect(access(cwd)).rejects.toThrow();
    const abort = new AbortController(); abort.abort(); await expect(provider.search('q', abort.signal)).rejects.toThrow();
  });
  it('uses the Node 24 single-address lookup contract for pinned IPv4 connections without network I/O', async () => {
    fakeLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    let inspected = false;
    fakeRequest.mockImplementationOnce((_url, options) => {
      const req = new EventEmitter();
      Object.assign(req, { end() {
        const socket = new Socket();
        socket.on('error', error => req.emit('error', error));
        socket.connect({ host: 'original.example', port: 443, family: options.family,
          lookup(host, lookupOptions, callback) {
            // Node chooses lookupOptions itself; the sentinel prevents any connect.
            options.lookup(host, lookupOptions, (_error: Error | null, address: unknown, family: number) => {
              inspected = true;
              try {
                expect(lookupOptions.all).not.toBe(true);
                expect(address).toBe('93.184.216.34');
                expect(family).toBe(4);
                callback(new Error('local lookup audit complete'), '', 4);
              } catch (error) { callback(error as Error, '', 4); }
            });
          },
        });
      } });
      return req;
    });
    await expect(fetchOriginal('https://original.example/article', signal())).rejects.toThrow('local lookup audit complete');
    expect(inspected).toBe(true);
    expect(fakeLookup).toHaveBeenCalledWith('original.example', { all: true, family: 4 });
  });

  it('blocks private, loopback, metadata, documentation, multicast, and credential URLs before retrieval', async () => {
    for (const ip of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.1.2', '192.168.1.2', '100.64.1.1', '198.18.1.1', '203.0.113.1', '224.0.0.1']) expect(publicIPv4(ip)).toBe(false);
    expect(publicIPv4('93.184.216.34')).toBe(true);
    for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com:8443', 'https://example.com/#fragment']) await expect(fetchOriginal(url, signal())).rejects.toThrow('Unsafe');
  });
  it.each(['refresh', 'concurrent-change', 'process-error'] as const)('persists Codex auth with compare-and-swap: %s', async mode => {
    const authHome = await mkdtemp(join(tmpdir(), 'fake-codex-auth-'));
    const original = JSON.stringify({ token: 'old-test-token' });
    const refreshed = JSON.stringify({ token: 'refreshed-test-token' });
    const concurrent = JSON.stringify({ token: 'newer-test-token' });
    const canonical = join(authHome, 'auth.json');
    vi.stubEnv('CODEX_HOME', authHome);
    try {
      await writeFile(canonical, original, { mode: 0o644 });
      const provider = new CodexResearchProvider({ runner: runnerReturning({ urls: [] }, async (_exe, _args, options) => {
        const copied = join(options.env!.CODEX_HOME!, 'auth.json');
        expect(await readFile(copied, 'utf8')).toBe(original);
        await writeFile(copied, refreshed);
        if (mode === 'concurrent-change') await writeFile(canonical, concurrent);
        if (mode === 'process-error') throw new Error('model failed after refresh');
        return '';
      }) });
      if (mode === 'process-error') await expect(provider.search('q', signal())).rejects.toThrow('model failed');
      else await provider.search('q', signal());
      expect(await readFile(canonical, 'utf8')).toBe(mode === 'concurrent-change' ? concurrent : refreshed);
      if (mode !== 'concurrent-change') expect((await stat(canonical)).mode & 0o777).toBe(0o600);
      await expect(access(canonical + '.workflow-refresh.lock')).rejects.toThrow();
    } finally { vi.unstubAllEnvs(); await rm(authHome, { recursive: true, force: true }); }
  });

  it('runs native Hermes with explicit no-tools/reasoning, private home, dossier stdin, and validated JSON', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'fake-tippgeber-')); let cwd = '';
    vi.stubEnv('HERMES_KANBAN_TASK', 'unrelated-worker-task');
    const prediction = { fixtureKey: 'key', probabilities: { home: 0.4, draw: 0.3, away: 0.3 }, expectedGoals: { home: 1, away: 1 }, score: { home: 1, away: 1 }, confidence: 0.5, factors: [{ reason: 'form', sourceUrl: source.url }] };
    try {
      await writeFile(join(profile, 'SOUL.md'), 'Use dossier only');
      await writeFile(join(profile, 'auth.json'), JSON.stringify({ token: 'old-test-token' }));
      await writeFile(join(profile, '.env'), 'TEST_ONLY=original');
      const predictor = new HermesPredictor({ profile, runner: async (_exe, args, options) => {
        cwd = options.cwd!; const bridge = await readFile(args[0], 'utf8');
        expect(bridge).toContain('enabled_toolsets=[]'); expect(bridge).toContain('"effort": "xhigh"'); expect(bridge).toContain('session_db=None');
        expect(bridge).toContain('skip_memory=True'); expect(options.env?.HERMES_HOME).toBe(join(cwd, 'hermes')); expect(options.env?.HERMES_SAFE_MODE).toBe('1'); expect(options.env?.HERMES_KANBAN_TASK).toBeUndefined();
        await writeFile(join(options.env!.HERMES_HOME!, 'auth.json'), JSON.stringify({ token: 'refreshed-test-token' }));
        await writeFile(join(options.env!.HERMES_HOME!, '.env'), 'TEST_ONLY=changed');
        expect(options.input).toContain('FINAL DOSSIER'); expect(args).not.toContain('FINAL DOSSIER'); return JSON.stringify(prediction);
      } });
      expect(await predictor.predict('FINAL DOSSIER', signal())).toEqual(prediction);
      expect(JSON.parse(await readFile(join(profile, 'auth.json'), 'utf8'))).toEqual({ token: 'refreshed-test-token' });
      expect(await readFile(join(profile, '.env'), 'utf8')).toBe('TEST_ONLY=original'); await expect(access(cwd)).rejects.toThrow();
      const invalid = new HermesPredictor({ profile, runner: async () => 'not JSON' }); await expect(invalid.predict('dossier', signal())).rejects.toThrow();
    } finally { vi.unstubAllEnvs(); await rm(profile, { recursive: true, force: true }); }
  });
});
