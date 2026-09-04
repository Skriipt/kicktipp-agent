import type { FetchLike } from '../browser.js';
import type { ServiceState } from './store.js';
import { readProviderResponse, requestProvider } from './provider-http.js';
import {
  resolveSecretReference,
  type TelegramTarget,
} from './targets.js';

type ReminderNotification = ServiceState['notifications'][number];
type AttemptOutcome = NonNullable<ServiceState['attempts'][number]['outcome']>;

export type TelegramDeliveryOutcome = AttemptOutcome & { retryAfterMilliseconds?: number };

const SEVERITY_MARKERS = {
  info: 'ℹ️',
  warning: '⚠️',
  urgent: '🚨',
} as const;

export class TelegramPayloadTooLargeError extends Error {
  constructor() {
    super('The Notification does not fit in one Telegram message.');
    this.name = 'TelegramPayloadTooLargeError';
  }
}

export class InvalidTelegramTargetError extends Error {
  constructor(readonly code: 'invalid_bot_token' | 'invalid_action_url') {
    super('The Telegram Notification Target is invalid.');
    this.name = 'InvalidTelegramTargetError';
  }
}

export function validateTelegramBotToken(value: string): string {
  if (!/^[1-9]\d*:[A-Za-z0-9_-]+$/u.test(value)) {
    throw new InvalidTelegramTargetError('invalid_bot_token');
  }
  return value;
}

function validateActionUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidTelegramTargetError('invalid_action_url');
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.hash
    || !(
      host === 'kicktipp.de'
      || host.endsWith('.kicktipp.de')
      || host === 'kicktipp.com'
      || host.endsWith('.kicktipp.com')
    )
  ) throw new InvalidTelegramTargetError('invalid_action_url');
  return url.toString();
}

export function resolveTelegramTarget(
  target: TelegramTarget,
  options: Parameters<typeof resolveSecretReference>[1] = {},
): { url: string } {
  const token = validateTelegramBotToken(resolveSecretReference(target.botTokenRef, options));
  return { url: `https://api.telegram.org/bot${token}/sendMessage` };
}

function neutralizeMentions(value: string): string {
  return value.replace(/@(?=[A-Za-z0-9_])/gu, '@\u200c');
}

export function telegramRequest(
  notification: ReminderNotification,
  target: TelegramTarget,
  options: Parameters<typeof resolveTelegramTarget>[1] = {},
): { url: string; body: string } {
  const text = `${SEVERITY_MARKERS[notification.content.severity]} ${neutralizeMentions(notification.content.title)}\n\n${neutralizeMentions(notification.content.message)}`;
  if (text.length > 4096) throw new TelegramPayloadTooLargeError();
  const actionUrl = validateActionUrl(notification.content.actionUrl);
  return {
    url: resolveTelegramTarget(target, options).url,
    body: JSON.stringify({
      chat_id: target.chatId,
      text,
      ...(target.topicId === undefined ? {} : { message_thread_id: target.topicId }),
      ...(actionUrl ? {
        reply_markup: { inline_keyboard: [[{ text: 'Kicktipp', url: actionUrl }]] },
      } : {}),
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

function headerRetryAfter(response: Response, now: Date): number | undefined {
  const value = response.headers.get('Retry-After');
  if (value === null) return undefined;
  if (/^\d+(?:\.\d+)?$/u.test(value)) {
    const milliseconds = Number(value) * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const instant = Date.parse(value);
  return Number.isFinite(instant) && instant >= now.getTime()
    ? instant - now.getTime()
    : undefined;
}

function telegramRetryAfter(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || !('parameters' in value)) return undefined;
  const parameters = value.parameters;
  if (!parameters || typeof parameters !== 'object' || !('retry_after' in parameters)) return undefined;
  const seconds = parameters.retry_after;
  const milliseconds = Number(seconds) * 1_000;
  return Number.isSafeInteger(seconds) && Number(seconds) >= 0 && Number.isSafeInteger(milliseconds)
    ? milliseconds
    : undefined;
}

function rejection(code: number, retryAfterMilliseconds?: number): TelegramDeliveryOutcome {
  if (code >= 500) return { state: 'unknown', retryable: false, safeErrorCode: 'provider_5xx' };
  const retryable = code === 429 || code === 408 || code === 425;
  return {
    state: 'failed',
    retryable,
    safeErrorCode: code === 429
      ? 'rate_limited'
      : code === 408 || code === 425
        ? 'temporary_rejection'
        : code === 401 || code === 404
          ? 'authentication_failed'
          : code === 403
            ? 'permission_denied'
            : code === 400
              ? 'invalid_target'
              : 'provider_rejected',
    ...(retryable && retryAfterMilliseconds !== undefined ? { retryAfterMilliseconds } : {}),
  };
}

function responseCode(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || !('error_code' in value)) return undefined;
  return Number.isInteger(value.error_code) ? Number(value.error_code) : undefined;
}

function validMessageId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export async function deliverTelegram(
  request: { url: string; body: string },
  options: { fetchImpl?: FetchLike; now?: Date; signal?: AbortSignal } = {},
): Promise<TelegramDeliveryOutcome> {
  const now = options.now ?? new Date();
  try {
    const response = await requestProvider(request.url, {
      method: 'POST',
      signal: options.signal,
      headers: { 'Content-Type': 'application/json' },
      body: request.body,
    }, options.fetchImpl);
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
      return { state: 'unknown', retryable: false, safeErrorCode: 'malformed_response' };
    }
    if (response.status >= 500) {
      return { state: 'unknown', retryable: false, safeErrorCode: 'provider_5xx' };
    }
    if (response.status >= 300 && response.status < 400) {
      return { state: 'failed', retryable: false, safeErrorCode: 'redirect_refused' };
    }

    const body = await readProviderResponse(response);
    if (!body.ok) {
      if (response.status >= 200 && response.status < 300) {
        return {
          state: 'unknown',
          retryable: false,
          safeErrorCode: body.reason === 'too_large' ? 'response_too_large' : 'malformed_receipt',
        };
      }
      return rejection(response.status, headerRetryAfter(response, now));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      if (response.status >= 200 && response.status < 300) {
        return { state: 'unknown', retryable: false, safeErrorCode: 'malformed_receipt' };
      }
      return rejection(response.status, headerRetryAfter(response, now));
    }
    if (
      response.status >= 200
      && response.status < 300
      && parsed
      && typeof parsed === 'object'
      && 'ok' in parsed
      && parsed.ok === true
    ) {
      const result = 'result' in parsed ? parsed.result : undefined;
      const messageId = result && typeof result === 'object' && 'message_id' in result
        ? result.message_id
        : undefined;
      if (!validMessageId(messageId)) {
        return { state: 'unknown', retryable: false, safeErrorCode: 'malformed_receipt' };
      }
      return {
        state: 'confirmed',
        retryable: false,
        receipt: { provider: 'telegram', messageId: String(messageId), acceptedAt: now.toISOString() },
      };
    }
    const code = responseCode(parsed);
    if (code !== undefined && parsed && typeof parsed === 'object' && 'ok' in parsed && parsed.ok === false) {
      return rejection(
        response.status >= 200 && response.status < 300 ? code : response.status,
        telegramRetryAfter(parsed) ?? headerRetryAfter(response, now),
      );
    }
    if (response.status >= 200 && response.status < 300) {
      return { state: 'unknown', retryable: false, safeErrorCode: 'malformed_receipt' };
    }
    return rejection(response.status, headerRetryAfter(response, now));
  } catch (error) {
    if (retryableTransportFailure(error)) {
      return { state: 'failed', retryable: true, safeErrorCode: 'connection_unavailable' };
    }
    return { state: 'unknown', retryable: false, safeErrorCode: 'transport_ambiguous' };
  }
}
