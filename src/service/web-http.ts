import fs from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SerialQueue } from './queue.js';
import { AdminError } from './admin.js';

export interface WebAdminOptions {
  token: string;
  handle: (path: string, method: string, body?: unknown) => Promise<unknown>;
  /** Exact origins explicitly configured by the local owner, not request headers. */
  allowedOrigins?: string[];
}

const assets: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};
const MAX_ADMIN_BODY = 64 * 1024;
const digest = (value: string) => createHash('sha256').update(value).digest();

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    let bytes = 0;
    let oversized = false;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      if (oversized) return;
      bytes += chunk.length;
      if (bytes > MAX_ADMIN_BODY) {
        oversized = true;
        chunks.length = 0;
        reject(new AdminError('body_too_large', 413));
      } else chunks.push(chunk);
    });
    request.on('end', () => { if (!oversized) resolve(Buffer.concat(chunks)); });
    request.on('error', reject);
    request.on('aborted', () => reject(new AdminError('request_aborted', 400)));
  });
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw new AdminError('invalid_json', 400); }
}

/** Serve a same-origin local UI, with no CORS or cookie authentication. */
export function createWebHandler(options: WebAdminOptions, gate: SerialQueue) {
  if (options.token.length < 32) throw new Error('Web access token is too short.');
  const expected = digest(options.token);
  const allowed = new Set(options.allowedOrigins ?? []);
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  for (const origin of allowed) allowedHosts.add(new URL(origin).host);
  const cache = new Map<string, Buffer>();

  return async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> => {
    const asset = assets[pathname];
    const admin = pathname.startsWith('/api/admin/');
    if (!asset && !admin) return false;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const host = request.headers.host;
    let local: URL;
    try {
      if (!host || /[\s/@\\]/.test(host)) throw new Error();
      local = new URL(`http://${host}`);
      if (!allowedHosts.has(local.hostname) && !allowedHosts.has(local.host)) throw new Error();
    } catch { json(response, 403, { error: 'host_not_allowed' }); return true; }
    // A custom hostname/port must be explicitly allowed. Never trust forwarded
    // headers supplied by a browser or an unconfigured reverse proxy.
    const origin = request.headers.origin;
    const sameOrigin = origin === local.origin || (origin === `https://${local.host}` && allowed.has(origin));
    if ((origin !== undefined && !sameOrigin) || request.headers['sec-fetch-site'] === 'cross-site') {
      json(response, 403, { error: 'origin_not_allowed' }); return true;
    }
    if (asset) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD'); json(response, 405, { error: 'method_not_allowed' }); return true;
      }
      let content = cache.get(pathname);
      if (!content) { content = fs.readFileSync(new URL(`../web/${asset.file}`, import.meta.url)); cache.set(pathname, content); }
      response.writeHead(200, { 'Content-Type': asset.type });
      response.end(request.method === 'HEAD' ? undefined : content);
      return true;
    }
    const token = /^Bearer[ \t]+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
    if (!token || !timingSafeEqual(expected, digest(token))) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="kicktipp-admin"');
      json(response, 401, { error: 'unauthorized' }); return true;
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      response.setHeader('Allow', 'GET, POST'); json(response, 405, { error: 'method_not_allowed' }); return true;
    }
    try {
      let body: unknown;
      if (request.method === 'POST') {
        if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          json(response, 415, { error: 'application_json_required' }); return true;
        }
        if (Number(request.headers['content-length'] ?? 0) > MAX_ADMIN_BODY) {
          request.resume(); json(response, 413, { error: 'body_too_large' }); return true;
        }
        body = await readJson(request);
      }
      const result = await gate.run(() => options.handle(pathname, request.method!, body));
      json(response, 200, result);
    } catch (error) {
      json(response, error instanceof AdminError ? error.status : 500, {
        error: error instanceof AdminError ? error.code : 'request_failed',
      });
    }
    return true;
  };
}
