import http, { type IncomingMessage } from 'node:http';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fork, type ChildProcess } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import { requestSchema, type DashboardRequest } from './catalog.js';

type Job = { id: string; status: 'running' | 'done' | 'failed'; output: string; result?: unknown; error?: string; code?: number | null };
const MAX_OUTPUT = 2 * 1024 * 1024;
const assets: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'],
};

async function readBody(request: IncomingMessage): Promise<unknown> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const data = Buffer.from(chunk);
    length += data.length;
    if (length > 256 * 1024) throw new Error('Anfrage ist zu groß.');
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function startDashboard(options: { port?: number; env?: NodeJS.ProcessEnv; profile?: string | null; community?: string | null } = {}) {
  const port = options.port ?? 3210;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port muss zwischen 0 und 65535 liegen.');
  const token = crypto.randomBytes(32).toString('hex');
  const jobs = new Map<string, Job>();
  const children = new Set<ChildProcess>();
  let serviceChild: ChildProcess | undefined;
  let serviceJob: string | undefined;
  let origin = '';
  let closing = false;

  function launch(request: DashboardRequest, service = false): Job {
    if (children.size >= 4) throw new Error('Vier Aktionen laufen bereits. Bitte kurz warten.');
    // ponytail: retain 100 completed actions in memory; persistent history is
    // already provided by the submission audit and reminder service stores.
    for (const [id, job] of jobs) {
      if (jobs.size < 100) break;
      if (job.status !== 'running' && id !== serviceJob) jobs.delete(id);
    }
    const job: Job = { id: crypto.randomUUID(), status: 'running', output: '' };
    jobs.set(job.id, job);
    const child = fork(new URL('./worker.js', import.meta.url), [], {
      execArgv: [], env: options.env ?? process.env, ...{ windowsHide: true },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    if (service) { serviceChild = child; serviceJob = job.id; }
    const secrets: string[] = [];
    function collect(value: unknown, key = ''): void {
      if (typeof value === 'string' && ['password', 'value', 'target'].includes(key) && value.length) secrets.push(value);
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) collect(v, k);
    }
    collect(request.payload);
    const redact = (value: string) => secrets.reduce((text, secret) => text.split(secret).join('[geschützt]'), stripVTControlCharacters(value));
    const append = (chunk: Buffer) => { job.output = (job.output + redact(chunk.toString('utf8'))).slice(-MAX_OUTPUT); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const reply = message as { result?: unknown; error?: string };
      if (reply.result !== undefined) job.result = reply.result;
      if (reply.error) job.error = redact(reply.error);
    });
    child.on('error', error => { job.error = redact(error.message); });
    const timer = service ? undefined : setTimeout(() => {
      job.error = 'Zeitlimit erreicht. Der Ausgang einer Schreibaktion kann unklar sein. Vor einem erneuten Versuch den Tipp-/Service-Status prüfen.';
      child.kill();
    }, 10 * 60_000);
    child.once('close', code => {
      clearTimeout(timer);
      children.delete(child);
      if (serviceChild === child) serviceChild = undefined;
      job.code = code;
      job.status = !job.error && code === 0 ? 'done' : 'failed';
      if (job.result === undefined) {
        try { job.result = JSON.parse(job.output.trim()); } catch { /* human-readable CLI output */ }
      }
    });
    child.send(request);
    return job;
  }

  const server = http.createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
    void (async () => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      const send = (code: number, value: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(value));
      };
      try {
        if (closing) { send(503, { error: 'Dashboard wird beendet.' }); return; }
        if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) {
          send(403, { error: 'Zugriff verweigert.' }); return;
        }
        const url = new URL(req.url ?? '/', origin);
        if (req.method === 'GET' && assets[url.pathname]) {
          const [file, type] = assets[url.pathname];
          const content = await readFile(new URL('./public/' + file, import.meta.url));
          res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
          res.end(content); return;
        }
        const supplied = Buffer.from(req.headers.authorization ?? '');
        const expected = Buffer.from('Bearer ' + token);
        if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
          send(401, { error: 'Bitte den vollständigen Dashboard-Link aus dem Terminal öffnen.' }); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/runtime') {
          send(200, { running: !!serviceChild, jobId: serviceJob ?? null, profile: options.profile ?? null, community: options.community ?? null }); return;
        }
        if (req.method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
          const job = jobs.get(url.pathname.slice('/api/jobs/'.length));
          send(job ? 200 : 404, job ?? { error: 'Aktion nicht mehr verfügbar.' }); return;
        }
        if (req.method !== 'POST' || url.pathname !== '/api/run') {
          send(404, { error: 'Nicht gefunden.' }); return;
        }
        if (!req.headers['content-type']?.startsWith('application/json')) {
          send(415, { error: 'JSON erforderlich.' }); return;
        }
        const request = requestSchema.parse(await readBody(req));
        if (request.operation === 'service-start' || request.operation === 'service-stop') {
          if (!request.confirmed) { send(400, { error: 'Bestätigung erforderlich.' }); return; }
          if (request.operation === 'service-start') {
            if (serviceChild) { send(409, { error: 'Dieser Service läuft bereits.' }); return; }
            const payload = z.object({ logFormat: z.enum(['text', 'json']).default('text') }).strict().parse(request.payload);
            send(202, launch({ ...request, operation: 'serve', payload }, true)); return;
          }
          if (!serviceChild) { send(409, { error: 'Kein von diesem Dashboard gestarteter Service läuft.' }); return; }
          serviceChild.send({ stop: true });
          send(200, { id: serviceJob }); return;
        }
        if (request.operation === 'serve') { send(400, { error: 'Ungültige Funktion.' }); return; }
        send(202, launch(request));
      } catch (error) {
        send(400, { error: error instanceof z.ZodError ? 'Ungültige Anfrage.' : error instanceof Error ? error.message : 'Aktion fehlgeschlagen.' });
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Dashboard konnte nicht gestartet werden.');
  origin = 'http://127.0.0.1:' + address.port;
  return {
    url: origin + '/#' + token,
    async close() {
      if (closing) return;
      closing = true;
      await Promise.all([...children].map(child => new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill(), 35_000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        if (child === serviceChild && child.connected) child.send({ stop: true });
        // Let in-flight submissions finish rather than silently interrupt them.
      })));
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}
