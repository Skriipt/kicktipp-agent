import type { FetchLike } from '../browser.js';
import type { ServiceState } from './store.js';
import {
  InvalidWebhookTargetError,
  resolveSecretReference,
  type DiscordTarget,
} from './targets.js';
import { readProviderResponse, requestProvider } from './provider-http.js';

type ReminderNotification = ServiceState['notifications'][number];
type AttemptOutcome = NonNullable<ServiceState['attempts'][number]['outcome']>;

export type DiscordDeliveryOutcome = AttemptOutcome & { retryAfterMilliseconds?: number };

const SEVERITY_COLORS = {
  info: 0x5865f2,
  warning: 0xfee75c,
  urgent: 0xed4245,
} as const;

export class DiscordPayloadTooLargeError extends Error {
  constructor() {
    super('The Notification does not fit in one Discord Embed.');
    this.name = 'DiscordPayloadTooLargeError';
  }
}

function invalidDiscordUrl(): never {
  throw new InvalidWebhookTargetError('invalid_url');
}

export function validateDiscordWebhookUrl(value: string): string {
  if (/\s|[\u0000-\u001f\u007f]/u.test(value) || value.includes('#')) invalidDiscordUrl();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidDiscordUrl();
  }
  if (
    url.origin !== 'https://discord.com'
    || url.username
    || url.password
    || url.search
    || !/^\/api(?:\/v\d+)?\/webhooks\/[1-9]\d*\/[A-Za-z0-9._-]+\/?$/u.test(url.pathname)
  ) invalidDiscordUrl();
  return url.toString();
}

export function resolveDiscordTarget(
  target: DiscordTarget,
  options: Parameters<typeof resolveSecretReference>[1] = {},
): { url: string } {
  return { url: validateDiscordWebhookUrl(resolveSecretReference(target.webhookUrlRef, options)) };
}

function escapeDiscordMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>~])/gu, '\\$1');
}

function validateActionUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidWebhookTargetError('invalid_url');
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.hash
    || ![
      host === 'kicktipp.de' || host.endsWith('.kicktipp.de'),
      host === 'kicktipp.com' || host.endsWith('.kicktipp.com'),
    ].some(Boolean)
  ) throw new InvalidWebhookTargetError('invalid_url');
  return url.toString();
}

export function discordRequest(
  notification: ReminderNotification,
  target: DiscordTarget,
  options: Parameters<typeof resolveDiscordTarget>[1] = {},
): { url: string; body: string } {
  const title = escapeDiscordMarkdown(notification.content.title);
  const description = escapeDiscordMarkdown(notification.content.message);
  if (title.length > 256 || description.length > 4096 || title.length + description.length > 6000) {
    throw new DiscordPayloadTooLargeError();
  }
  const actionUrl = validateActionUrl(notification.content.actionUrl);
  return {
    url: resolveDiscordTarget(target, options).url,
    body: JSON.stringify({
      allowed_mentions: { parse: [] },
      embeds: [{
        title,
        description,
        color: SEVERITY_COLORS[notification.content.severity],
        ...(actionUrl ? { url: actionUrl } : {}),
      }],
    }),
  };
}

function retryableTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('cause' in error)) return false;
  const cause = error.cause;
  return !!cause
    && typeof cause === 'object'
    && 'code' in cause
    && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(String(cause.code));
}

function retryAfterMilliseconds(response: Response, now: Date): number | undefined {
  const value = response.headers.get('Retry-After');
  if (value === null) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const milliseconds = Number(value) * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const instant = Date.parse(value);
  return Number.isFinite(instant) && instant >= now.getTime()
    ? instant - now.getTime()
    : undefined;
}

function isDiscordMessageId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[1-9]\d{0,19}$/.test(value)
    && BigInt(value) <= 18_446_744_073_709_551_615n;
}

export async function deliverDiscord(
  request: { url: string; body: string },
  options: { fetchImpl?: FetchLike; now?: Date; signal?: AbortSignal } = {},
): Promise<DiscordDeliveryOutcome> {
  const now = options.now ?? new Date();
  const url = new URL(request.url);
  url.searchParams.set('wait', 'true');
  try {
    const response = await requestProvider(url.toString(), {
      method: 'POST',
      signal: options.signal,
      headers: { 'Content-Type': 'application/json' },
      body: request.body,
    }, options.fetchImpl);
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      return { state: 'unknown', retryable: false, safeErrorCode: 'malformed_response' };
    }
    if (response.status >= 200 && response.status < 300) {
      const body = await readProviderResponse(response);
      if (!body.ok) {
        return {
          state: 'unknown',
          retryable: false,
          safeErrorCode: body.reason === 'too_large' ? 'response_too_large' : 'malformed_receipt',
        };
      }
      try {
        const receipt = JSON.parse(body.text) as { id?: unknown };
        if (!receipt || typeof receipt !== 'object' || !isDiscordMessageId(receipt.id)) {
          return { state: 'unknown', retryable: false, safeErrorCode: 'malformed_receipt' };
        }
        return {
          state: 'confirmed',
          retryable: false,
          receipt: { provider: 'discord', messageId: receipt.id, acceptedAt: now.toISOString() },
        };
      } catch {
        return { state: 'unknown', retryable: false, safeErrorCode: 'malformed_receipt' };
      }
    }
    if (response.status >= 500) {
      return { state: 'unknown', retryable: false, safeErrorCode: 'provider_5xx' };
    }
    if (response.status === 429 || response.status === 408 || response.status === 425) {
      const retryAfter = retryAfterMilliseconds(response, now);
      return {
        state: 'failed',
        retryable: true,
        safeErrorCode: response.status === 429 ? 'rate_limited' : 'temporary_rejection',
        ...(retryAfter === undefined ? {} : { retryAfterMilliseconds: retryAfter }),
      };
    }
    return {
      state: 'failed',
      retryable: false,
      safeErrorCode: response.status >= 300 && response.status < 400
        ? 'redirect_refused'
        : response.status === 401
          ? 'authentication_failed'
          : response.status === 403
            ? 'permission_denied'
            : response.status === 404
              ? 'invalid_target'
              : 'provider_rejected',
    };
  } catch (error) {
    if (retryableTransportFailure(error)) {
      return { state: 'failed', retryable: true, safeErrorCode: 'connection_unavailable' };
    }
    return { state: 'unknown', retryable: false, safeErrorCode: 'transport_ambiguous' };
  }
}
