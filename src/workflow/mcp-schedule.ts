import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixtureSchema, sameFixture, type Fixture } from './model.js';
import type { WorkflowScope } from './kicktipp.js';
import { bounded } from './research.js';

export interface ScheduleSource { fetch(signal: AbortSignal): Promise<Fixture[]> }

/** Read-only MCP connection to this checkout; no model participates in polling. */
export class McpScheduleSource implements ScheduleSource {
  constructor(private readonly scope: WorkflowScope, private readonly matchdays: number[], private readonly serverPath = fileURLToPath(new URL('../server.js', import.meta.url))) {}
  async fetch(parent: AbortSignal): Promise<Fixture[]> {
    return bounded(60_000, async signal => {
      const child = spawn(process.execPath, [this.serverPath], {
        shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, KICKTIPP_READ_ONLY: '1' },
      });
      let id = 0, buffer = '', bytes = 0;
      const pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
      const stop = () => {
        for (const p of pending.values()) p.reject(new Error('Schedule MCP unavailable'));
        pending.clear();
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* Already closed. */ }
      };
      signal.addEventListener('abort', stop, { once: true });
      child.on('error', stop); child.on('close', stop);
      child.stdin.on('error', stop);
      child.stderr.on('data', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        bytes += Buffer.byteLength(chunk); if (bytes > 4_000_000) { stop(); return; }
        buffer += chunk;
        let at: number;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
          try {
            const msg = JSON.parse(line);
            const p = pending.get(msg.id);
            if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error('Schedule MCP rejected request')) : p.resolve(msg.result); }
          } catch { stop(); }
        }
      });
      const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const requestId = ++id; pending.set(requestId, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      });
      try {
        await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'workflow-scheduler', version: '1' } });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        const fixtures: Fixture[] = [];
        const requested: Array<number | undefined> = this.matchdays.length ? [...this.matchdays] : [undefined];
        for (const matchday of requested) {
          const result = await request('tools/call', { name: 'get_workflow_fixtures', arguments: { ...this.scope, matchday } });
          if (result.isError) throw new Error('Schedule identity unavailable');
          const data = result.structuredContent?.data;
          for (const raw of data?.fixtures ?? []) {
            const f = fixtureSchema.parse(raw);
            if (!sameFixture(f, { ...f, ...this.scope, ...(matchday === undefined ? {} : { matchday: String(matchday) }) })) throw new Error('Schedule scope mismatch');
            fixtures.push(f);
          }
          if (!Array.isArray(data?.fixtures)) throw new Error('Schedule response missing fixtures');
          if (matchday === undefined && fixtures.length) {
            const current = Number(fixtures[0].matchday);
            if (current < 34) requested.push(current + 1);
          }
        }
        return fixtures;
      } finally { signal.removeEventListener('abort', stop); stop(); }
    }, parent);
  }
}
