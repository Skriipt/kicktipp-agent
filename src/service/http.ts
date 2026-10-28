import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer, discardSession, type McpServerOptions } from '../server.js';
import { kicktippQueue, SerialQueue } from './queue.js';
import { createWebHandler, type WebAdminOptions } from './web-http.js';

const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpServiceOptions {
  host: string;
  port: number;
  token: string | (() => string | null);
  web?: WebAdminOptions;
  allowedOrigins?: string[];
  /** Must contain operational status only, never configuration secrets. */
  status: () => unknown;
  profileAccess?: Pick<McpServerOptions, 'profiles' | 'withProfile'>;
}

export interface HttpService {
  server: Server;
  port: number;
  close(): Promise<void>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(new Error('body_too_large'));
      } else {
        chunks.push(chunk);
      }
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
    request.on('aborted', () => reject(new Error('request_aborted')));
  });
}

/**
 * One authenticated endpoint for both current and legacy Streamable HTTP
 * clients. The SDK owns protocol negotiation and per-request transport cleanup;
 * there are no client sessions to accumulate in the daemon.
 */
export async function startHttpService(options: HttpServiceOptions): Promise<HttpService> {
  const initialToken = typeof options.token === 'function' ? options.token() : options.token;
  if (initialToken !== null && (initialToken.length < 32 || /\s/.test(initialToken))) {
    throw new Error('The MCP access token must contain at least 32 non-whitespace characters. Run setup.');
  }
  const gate = new SerialQueue();
  const web = options.web ? createWebHandler(options.web, gate) : undefined;
  const origins = new Set(options.allowedOrigins ?? []);
  const handler = createMcpHandler(
    () => createMcpServer({ lockedConfiguration: true, serviceStatus: options.status, ...options.profileAccess }),
    { legacy: 'stateless', maxSubscriptions: 0 },
  );
  let stopping = false;

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      // SDK/transport errors can contain request data. Do not leak them into
      // HTTP responses or unattended container logs.
      if (!response.headersSent) json(response, 500, { error: 'request_failed' });
      else response.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (stopping) {
      json(response, 503, { error: 'stopping' });
      return;
    }
    if (!request.url?.startsWith('/')) {
      json(response, 400, { error: 'invalid_path' });
      return;
    }
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (web && await web(request, response, pathname)) return;
    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      json(response, 403, { error: 'origin_not_allowed' });
      return;
    }
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version');
      response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    }
    if (pathname === '/health' && request.method === 'GET') {
      json(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'OPTIONS' && pathname === '/mcp' && origin) {
      response.writeHead(204);
      response.end();
      return;
    }
    const currentToken = typeof options.token === 'function' ? options.token() : options.token;
    if (!currentToken) { json(response, 503, { error: 'setup_required' }); return; }
    const expectedToken = digest(currentToken);
    const token = /^Bearer[ \t]+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
    if (!token || !timingSafeEqual(expectedToken, digest(token))) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="kicktipp"');
      json(response, 401, { error: 'unauthorized' });
      return;
    }
    if (pathname === '/status' && request.method === 'GET') {
      json(response, 200, options.status());
      return;
    }
    if (pathname !== '/mcp') {
      json(response, 404, { error: 'not_found' });
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      json(response, 405, { error: 'method_not_allowed' });
      return;
    }
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      json(response, 415, { error: 'application_json_required' });
      return;
    }
    if (Number(request.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
      request.resume();
      json(response, 413, { error: 'body_too_large' });
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(request);
    } catch (error) {
      if (error instanceof Error && error.message === 'body_too_large') {
        json(response, 413, { error: 'body_too_large' });
      }
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const controller = new AbortController();
    const abort = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.on('close', abort);
    try {
      await gate.run(async () => {
        const reply = await handler.fetch(new Request('http://localhost/mcp', {
          method: 'POST', headers, body: new Uint8Array(body), signal: controller.signal,
        }));
        response.statusCode = reply.status;
        reply.headers.forEach((value, key) => response.setHeader(key, value));
        response.setHeader('Cache-Control', 'no-store');
        if (stopping) response.setHeader('Connection', 'close');
        // Legacy clients receive a finite SSE response. Stream it without
        // buffering; backpressure prevents slow clients from growing memory.
        if (reply.body) {
          const reader = reply.body.getReader();
          try {
            while (!response.destroyed) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!response.write(value)) await once(response, 'drain', { signal: controller.signal });
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }
        }
        response.end();
      });
    } finally {
      response.off('close', abort);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP listener has no TCP address.');
  let closing: Promise<void> | undefined;
  return {
    server,
    port: address.port,
    close() {
      closing ??= (async () => {
        stopping = true;
        const closed = new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
        server.closeIdleConnections();
        // Existing submissions finish and return their verified result before
        // transport teardown. Closing a socket is not proof a write failed.
        await closed;
        await kicktippQueue.idle();
        await handler.close();
        await discardSession();
      })();
      return closing;
    },
  };
}
