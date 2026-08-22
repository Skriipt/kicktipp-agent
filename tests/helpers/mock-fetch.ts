import type { FetchLike } from '../../src/http/page.js';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

export interface MockResponse {
  status?: number;
  body?: string;
  location?: string;
  setCookies?: string[];
  headers?: Record<string, string>;
}

export type Handler = (req: RecordedRequest) => MockResponse | undefined;

const NOT_FOUND: MockResponse = {
  status: 404,
  body: '<html><body>Seite wurde nicht gefunden</body></html>',
};

/**
 * A fetch stand-in driven by a handler function, so the HTTP layer can be
 * exercised end to end without touching the network.
 */
export function mockFetch(handler: Handler): {
  fetchImpl: FetchLike;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];

  const fetchImpl: FetchLike = async (input, init = {}) => {
    const req: RecordedRequest = {
      url: String(input),
      method: (init.method || 'GET').toUpperCase(),
      headers: new Headers((init.headers as HeadersInit) || {}),
      body: init.body === undefined || init.body === null ? null : String(init.body),
    };
    calls.push(req);

    const result = handler(req) ?? NOT_FOUND;
    const headers = new Headers();
    for (const [key, value] of Object.entries(result.headers || {})) {
      headers.set(key, value);
    }
    if (result.location) headers.set('location', result.location);
    for (const cookie of result.setCookies || []) headers.append('set-cookie', cookie);

    return new Response(result.body ?? '', {
      status: result.status ?? 200,
      headers,
    });
  };

  return { fetchImpl, calls };
}

/** Build a handler from an exact-URL lookup table. */
export function routes(table: Record<string, MockResponse>): Handler {
  return (req) => table[req.url];
}

export function page(body: string): MockResponse {
  return { status: 200, body: `<html><body>${body}</body></html>` };
}
