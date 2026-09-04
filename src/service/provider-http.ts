import type { FetchLike } from '../browser.js';
import { VERSION } from '../version.js';

const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;

export function validateKicktippActionUrl(
  value: string | undefined,
  invalid: () => never,
): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.hash
    || !(host === 'kicktipp.de' || host.endsWith('.kicktipp.de')
      || host === 'kicktipp.com' || host.endsWith('.kicktipp.com'))
  ) return invalid();
  return url.toString();
}

export function retryableTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('cause' in error)) return false;
  const cause = error.cause;
  return !!cause
    && typeof cause === 'object'
    && 'code' in cause
    && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(String(cause.code));
}

export function retryAfterMilliseconds(
  response: Response,
  now: Date,
  fractionalSeconds = false,
): number | undefined {
  const value = response.headers.get('Retry-After');
  if (value === null) return undefined;
  if ((fractionalSeconds ? /^\d+(?:\.\d+)?$/ : /^\d+$/).test(value)) {
    const milliseconds = Number(value) * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const instant = Date.parse(value);
  return Number.isFinite(instant) && instant >= now.getTime() ? instant - now.getTime() : undefined;
}

export function requestProvider(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike = (input, requestInit) => fetch(input, requestInit),
): Promise<Response> {
  const timeout = AbortSignal.timeout(15_000);
  return fetchImpl(url, {
    ...init,
    redirect: 'manual',
    signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
    headers: {
      'User-Agent': `kicktipp-agent/${VERSION} service`,
      ...init.headers as Record<string, string>,
    },
  });
}

export async function readProviderResponse(
  response: Response,
): Promise<{ ok: true; text: string } | { ok: false; reason: 'too_large' | 'unreadable' }> {
  const length = response.headers.get('Content-Length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_PROVIDER_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'too_large' };
  }
  if (!response.body) return { ok: true, text: '' };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}
