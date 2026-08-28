import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';
import { CookieJar } from '../http/cookie-jar.js';
import { Page, type FetchLike } from '../http/page.js';
import { getCommunities, login } from '../browser.js';
import { saveAuth, saveCommunity, saveReadOnly, sessionFile, type AuthStore } from '../config.js';
import { communityPage, donePage, forbiddenPage, loginPage } from './html.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

export type SetupOutcome = 'saved' | 'rejected' | 'timeout';

export interface SetupHandle {
  url: string;
  finished: Promise<SetupOutcome>;
  close: () => Promise<void>;
}

export interface StartSetupOptions {
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  onSaved?: () => void;
  /**
   * When false, the listener does not keep the Node process alive. MCP stdio
   * needs that so a get_status call cannot pin the process after stdin closes.
   * CLI `login --web` leaves the default (true) so the process waits.
   */
  keepAlive?: boolean;
}

type Phase =
  | { kind: 'login' }
  | { kind: 'community'; communities: string[] };

function tokensMatch(expected: string, given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function headerLine(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackHost(host: string, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function isLoopbackOrigin(origin: string | undefined, port: number): boolean {
  if (!origin || origin === 'null') return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function isLoopbackRequest(req: IncomingMessage, port: number): boolean {
  const host = headerLine(req.headers.host) ?? '';
  if (!isLoopbackHost(host, port)) return false;
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') return true;
  return isLoopbackOrigin(headerLine(req.headers.origin), port);
}

function send(res: ServerResponse, status: number, html: string): Promise<void> {
  return new Promise((resolve) => {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Length': Buffer.byteLength(html),
    });
    res.end(html, () => resolve());
  });
}

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request too large');
    chunks.push(buf);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function tokenFrom(req: IncomingMessage, body: URLSearchParams | null): string | null {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  return body?.get('token') || url.searchParams.get('token');
}

/**
 * One-shot loopback listener that collects Kicktipp credentials in a browser
 * form so they never enter the chat or an MCP client's JSON config.
 */
export function startSetupListener(opts: StartSetupOptions = {}): Promise<SetupHandle> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let phase: Phase = { kind: 'login' };
  let closed = false;
  let settle: (outcome: SetupOutcome) => void = () => {};
  const finished = new Promise<SetupOutcome>((resolve) => {
    settle = resolve;
  });

  const token = crypto.randomBytes(32).toString('hex');
  let port = 0;

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  async function shutdown(outcome: SetupOutcome): Promise<void> {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    settle(outcome);
  }

  async function forbid(res: ServerResponse): Promise<void> {
    await send(res, 403, forbiddenPage());
  }

  async function rejectToken(res: ServerResponse): Promise<void> {
    await forbid(res);
    await shutdown('rejected');
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (closed) {
        await forbid(res);
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/setup') {
        await send(res, 404, forbiddenPage());
        return;
      }
      if (!isLoopbackRequest(req, port)) {
        await forbid(res);
        return;
      }

      const method = req.method ?? 'GET';
      if (method === 'GET' || method === 'HEAD') {
        if (!tokensMatch(token, tokenFrom(req, null))) {
          await forbid(res);
          return;
        }
        const html = phase.kind === 'community' ? communityPage(token, phase.communities) : loginPage(token);
        await send(res, 200, method === 'HEAD' ? '' : html);
        return;
      }

      if (method !== 'POST') {
        await send(res, 405, forbiddenPage());
        return;
      }

      const body = await readBody(req);
      if (!tokensMatch(token, tokenFrom(req, body))) {
        await rejectToken(res);
        return;
      }

      const step = body.get('step');
      if (step === 'community' && phase.kind === 'community') {
        const community = body.get('community') ?? '';
        if (!phase.communities.includes(community)) {
          await send(res, 200, communityPage(token, phase.communities, 'Pick one of the listed communities.'));
          return;
        }
        saveCommunity(community);
        opts.onSaved?.();
        await send(res, 200, donePage());
        await shutdown('saved');
        return;
      }

      if (step !== 'login' || phase.kind !== 'login') {
        await send(res, 200, loginPage(token, 'Start again from the sign-in form.'));
        return;
      }

      const email = (body.get('email') ?? '').trim();
      const password = body.get('password') ?? '';
      if (!email || !password) {
        await send(res, 200, loginPage(token, 'Email and password are required.'));
        return;
      }

      const store: AuthStore = body.get('store') === 'session' ? 'session' : 'password';
      const readOnly = body.get('read_only') === '1';
      const page = new Page(new CookieJar(), opts.fetchImpl);
      try {
        await login(page, email, password);
      } catch (err) {
        const raw = err instanceof Error ? err.message : '';
        const message = /login failed/i.test(raw)
          ? 'Sign-in failed. Check the email and password.'
          : raw || 'Sign-in failed. Check the email and password.';
        await send(res, 200, loginPage(token, message));
        return;
      }

      saveAuth({ email, password: store === 'password' ? password : undefined, store });
      saveReadOnly(readOnly);
      page.saveSession(sessionFile());

      const communities = await getCommunities(page);
      if (communities.length === 0) {
        opts.onSaved?.();
        await send(res, 200, donePage());
        await shutdown('saved');
        return;
      }
      if (communities.length === 1) {
        saveCommunity(communities[0]);
        opts.onSaved?.();
        await send(res, 200, donePage());
        await shutdown('saved');
        return;
      }

      phase = { kind: 'community', communities };
      await send(res, 200, communityPage(token, communities));
    } catch {
      await send(res, 500, loginPage(token, 'Something went wrong. Try again.'));
    }
  }

  const timer = setTimeout(() => {
    void shutdown('timeout');
  }, timeoutMs);

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Setup listener did not bind a TCP port.'));
        return;
      }
      port = addr.port;
      if (opts.keepAlive === false) {
        server.unref();
        timer.unref();
      }
      resolve({
        url: `http://127.0.0.1:${port}/setup?token=${token}`,
        finished,
        close: () => shutdown('rejected'),
      });
    });
    server.on('error', reject);
  });
}

let active: SetupHandle | null = null;

/** Reuse one listener per process so get_status and later tools share the URL. */
export async function ensureSetupListener(opts: StartSetupOptions = {}): Promise<string> {
  if (active) return active.url;
  const handle = await startSetupListener(opts);
  active = handle;
  void handle.finished.finally(() => {
    if (active === handle) active = null;
  });
  return handle.url;
}
