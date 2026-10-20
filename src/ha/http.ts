import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { z } from 'zod';
import { createScopedClient } from '../client.js';
import { fetchBets, placeBets } from '../core.js';
import { fetchTipStatus } from '../tip-status.js';
import { hasUsableAuth, isSessionOnly, loadCommunity } from '../config.js';
import { assertWritable, isReadOnly, ReadOnlyError } from '../read-only.js';
import { lockedProfile, ProfilePolicyError } from '../profile-policy.js';
import type { FetchLike } from '../browser.js';

export function requiredHaProfile(): string {
  const profile = process.env.KICKTIPP_PROFILE?.trim();
  if (!profile) throw new Error('KICKTIPP_PROFILE is required for the HA server.');
  return profile;
}
const MAX_BODY_BYTES = 16 * 1024;
const matchdaySchema = z.number().int().min(1).max(99);
const slipSchema = z.strictObject({
  bets: z.array(z.string().min(1).max(300).regex(/^.+ vs .+=\d{1,2}:\d{1,2}$/)).min(1).max(100),
  matchday: matchdaySchema.optional(),
  dry_run: z.boolean().default(true),
  confirm: z.boolean().default(false),
});

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function validateHaToken(token: string): void {
  if (!/^[A-Za-z0-9._~-]{32,512}$/.test(token)) {
    throw new Error('HA bearer token must contain 32 to 512 URL-safe characters.');
  }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, 'json_required');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new RequestError(413, 'body_too_large');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'invalid_json');
  }
}

export interface HaServerOptions {
  token: string;
  /** Upstream injection for fixture tests; never selectable through HTTP. */
  fetchImpl?: FetchLike;
}

/** Fixed account, fixed community, independent pages; no generic tool dispatch. */
export function createHaServer(options: HaServerOptions): http.Server {
  validateHaToken(options.token);
  const profile = requiredHaProfile();
  if (lockedProfile() !== profile) {
    throw new ProfilePolicyError('The HA server requires its configured profile lock.');
  }
  const community = loadCommunity();
  if (!community) throw new Error('Configure a community in the selected profile before starting HA.');
  const client = createScopedClient({
    profileId: profile,
    communityId: community,
    fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) })),
  });
  const tokenHash = crypto.createHash('sha256').update(`Bearer ${options.token}`).digest();
  const identity = { profile, community };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let submitting = false;
    try {
      // Authenticate before routing, reading bodies, or contacting Kicktipp.
      const givenHash = crypto.createHash('sha256').update(req.headers.authorization ?? '').digest();
      if (!crypto.timingSafeEqual(tokenHash, givenHash)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        throw new RequestError(401, 'unauthorized');
      }
      // This API is for HA's backend, not browser clients. No cookies or CORS.
      if (req.headers.origin !== undefined) throw new RequestError(403, 'browser_origin_forbidden');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const reads = ['/v1/health', '/v1/status', '/v1/bets', '/v1/tip-status'];
      if (!reads.includes(url.pathname)) throw new RequestError(404, 'not_found');
      if (method !== 'GET' && !(method === 'POST' && url.pathname === '/v1/bets')) {
        res.setHeader('Allow', url.pathname === '/v1/bets' ? 'GET, POST' : 'GET');
        throw new RequestError(405, 'method_not_allowed');
      }

      let matchday: number | undefined;
      for (const key of url.searchParams.keys()) {
        if (method !== 'GET' || !['/v1/bets', '/v1/tip-status'].includes(url.pathname) || key !== 'matchday') {
          throw new RequestError(400, 'unexpected_query');
        }
      }
      if (url.searchParams.has('matchday')) {
        const values = url.searchParams.getAll('matchday');
        if (values.length !== 1 || !/^\d{1,2}$/.test(values[0])) throw new RequestError(400, 'invalid_matchday');
        const parsed = matchdaySchema.safeParse(Number(values[0]));
        if (!parsed.success) throw new RequestError(400, 'invalid_matchday');
        matchday = parsed.data;
      }
      if (method === 'GET') {
        if (url.pathname === '/v1/health') {
          send(res, 200, { ok: true, ...identity });
        } else if (url.pathname === '/v1/status') {
          send(res, 200, { ...identity, read_only: isReadOnly(), credentials_saved: hasUsableAuth(), session_only: isSessionOnly() });
        } else {
          const data = await client.read(async (page, pool) => {
            const result = await (url.pathname === '/v1/bets'
              ? fetchBets(page, pool, matchday)
              : fetchTipStatus(page, pool, matchday));
            if (page.responseStatus() >= 400) throw new Error('Kicktipp read failed.');
            return result;
          });
          send(res, 200, { ...identity, matchday: matchday ?? null, data });
        }
        return;
      }

      const parsed = slipSchema.safeParse(await readJson(req));
      if (!parsed.success) throw new RequestError(400, 'invalid_slip');
      const slip = parsed.data;
      if (!slip.dry_run && !slip.confirm) throw new RequestError(400, 'confirmation_required');
      if (!slip.dry_run) assertWritable('HA bet submission');
      submitting = !slip.dry_run;
      const placed = await client.write((page, pool) =>
        placeBets(page, pool, slip.bets, slip.matchday, !slip.dry_run, 'ha:place_bets'),
      );
      send(res, 200, { ...identity, dry_run: slip.dry_run, placed });
    } catch (error) {
      // Do not return upstream pages, paths, credentials, or raw errors.
      res.shouldKeepAlive = false;
      if (error instanceof RequestError) send(res, error.status, { error: error.code });
      else if (error instanceof ReadOnlyError) send(res, 403, { error: 'read_only' });
      else if (error instanceof ProfilePolicyError) send(res, 403, { error: 'profile_locked' });
      else send(res, 502, { error: submitting ? 'submission_unknown' : 'kicktipp_unavailable' });
    }
  }

  const server = http.createServer((req, res) => { void handle(req, res); });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxConnections = 64;
  return server;
}
