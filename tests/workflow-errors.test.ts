import { it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../src/workflow/process.js';
import { Workflow } from '../src/workflow/engine.js';
import { FileWorkflowStore } from '../src/workflow/store.js';

it('persists the R1 provider error code and exit status without private stderr', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-error-'));
  try {
    const fixture = { profile: 'test', community: 'test', season: '2026', competition: 'League', matchday: '1', fixtureId: '1', home: 'Home', away: 'Away', kickoff: Date.now() + 3_600_000 };
    const store = new FileWorkflowStore(root, 'test');
    const predict = vi.fn(), submit = vi.fn();
    const workflow = new Workflow(store, () => ({
      search: async () => [], open: async () => { throw new Error('unexpected'); },
      investigate: async (_input, _tools, signal) => runProcess(process.execPath, ['-e',
        'console.error(\'token=private-canary https://private.invalid/path\\nERROR: {"error":{"code":"invalid_json_schema","message":"private details"}}\');process.exit(1)'], { signal }),
    }), { predict }, { submit, read: async () => null }, undefined, { testMode: true, mode: 'full' });
    await workflow.tick(fixture);
    const state = store.read(fixture);
    expect(state.status).toBe('scheduled');
    expect(state.r1?.complete).toBe(false);
    expect(state.r1?.evidence).toEqual([]);
    const saved = readFileSync(store.files(fixture).state, 'utf8');
    expect(saved).toContain('invalid_json_schema');
    expect(saved).toContain('exit 1');
    expect(saved).not.toMatch(/private-canary|private.invalid|private details/);
    expect(predict).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('distinguishes output exhaustion from user cancellation', async () => {
  await expect(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(1000))'], {
    signal: new AbortController().signal, maxOutputBytes: 10,
  })).rejects.toThrow('output_limit');
});
