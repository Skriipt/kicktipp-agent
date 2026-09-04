import type { FetchLike } from '../browser.js';
import type { ServicePaths } from './paths.js';
import { readProviderResponse, requestProvider } from './provider-http.js';
import {
  ntfyServerUrlSchema,
  ntfyTopicSchema,
  type ServiceState,
} from './store.js';
import { resolveSecretReference, type NtfyTarget } from './targets.js';

type ReminderNotification = ServiceState['notifications'][number];
type AttemptOutcome = NonNullable<ServiceState['attempts'][number]['outcome']>;

export type NtfyDeliveryOutcome = AttemptOutcome & { retryAfterMilliseconds?: number };

const PRIORITIES = { info: 3, warning: 4, urgent: 5 } as const;
const MAX_MESSAGE_BYTES = 4_096;
const MAX_TITLE_BYTES = 1_024;
const MAX_JSON_BYTES = MAX_MESSAGE_BYTES * 2;

export class NtfyPayloadTooLargeError extends Error {
  constructor() {
    super('The Notification does not fit in one ntfy message.');
    this.name = 'NtfyPayloadTooLargeError';
  }
}

export class InvalidNtfyTargetError extends Error {
  constructor(readonly code: 'invalid_url' | 'insecure_http' | 'invalid_topic' | 'invalid_token' | 'invalid_action_url') {
    super('The ntfy Notification Target is invalid.');
    this.name = 'InvalidNtfyTargetError';
  }
}

export function validateNtfyServerUrl(value: string, allowInsecureHttp = false): string {
  const parsed = ntfyServerUrlSchema.safeParse(value);
  if (!parsed.success) throw new InvalidNtfyTargetError('invalid_url');
  const url = new URL(parsed.data);
  if (url.protocol === 'http:' && !allowInsecureHttp) {
    throw new InvalidNtfyTargetError('insecure_http');
  }
  return url.toString();
}

export function validateNtfyTopic(value: string): string {
  const parsed = ntfyTopicSchema.safeParse(value);
  if (!parsed.success) throw new InvalidNtfyTargetError('invalid_topic');
  return parsed.data;
}

export function validateNtfyToken(value: string): string {
  if (!/^tk_[-_A-Za-z0-9]{29}$/u.test(value)) {
    throw new InvalidNtfyTargetError('invalid_token');
  }
  return value;
}

function validateActionUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidNtfyTargetError('invalid_action_url');
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
  ) throw new InvalidNtfyTargetError('invalid_action_url');
  return url.toString();
}

export function ntfyRequest(
  notification: ReminderNotification,
  target: NtfyTarget,
  options: { env?: NodeJS.ProcessEnv; paths?: ServicePaths } = {},
): { url: string; headers: Record<string, string>; body: string } {
  const url = validateNtfyServerUrl(target.serverUrl, target.allowInsecureHttp);
  const actionUrl = validateActionUrl(notification.content.actionUrl);
  const payload = {
    topic: validateNtfyTopic(target.topic),
    title: notification.content.title,
    message: notification.content.message,
    priority: PRIORITIES[notification.content.severity],
    ...(actionUrl ? { actions: [{ action: 'view', label: 'Kicktipp', url: actionUrl }] } : {}),
  };
  const body = JSON.stringify(payload);
  const bytes = new TextEncoder();
  if (
    bytes.encode(payload.title).byteLength > MAX_TITLE_BYTES
    || bytes.encode(payload.message).byteLength > MAX_MESSAGE_BYTES
    || bytes.encode(body).byteLength > MAX_JSON_BYTES
  ) throw new NtfyPayloadTooLargeError();
  return {
    url,
    headers: {
      'Content-Type': 'application/json',
      ...(target.tokenRef ? {
        Authorization: `Bearer ${validateNtfyToken(resolveSecretReference(target.tokenRef, options))}`,
      } : {}),
    },
    body,
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
  if (/^\d+(?:\.\d+)?$/u.test(value)) {
    const milliseconds = Number(value) * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const instant = Date.parse(value);
  return Number.isFinite(instant) && instant >= now.getTime() ? instant - now.getTime() : undefined;
}

function rejection(status: number, retryAfter?: number): NtfyDeliveryOutcome {
  if (status >= 500) return { state: 'unknown', retryable: false, safeErrorCode: 'provider_5xx' };
  const retryable = status === 429 || status === 408 || status === 425;
  return {
    state: 'failed',
    retryable,
    safeErrorCode: status >= 300 && status < 400
      ? 'redirect_refused'
      : status === 401
        ? 'authentication_failed'
        : status === 403
          ? 'permission_denied'
          : status === 400 || status === 404
            ? 'invalid_target'
            : status === 429
              ? 'rate_limited'
              : status === 408 || status === 425
                ? 'temporary_rejection'
                : 'provider_rejected',
    ...(retryable && retryAfter !== undefined ? { retryAfterMilliseconds: retryAfter } : {}),
  };
}

function validMessageId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9]{12}$/u.test(value);
}

export async function deliverNtfy(
  request: { url: string; headers: Record<string, string>; body: string },
  options: { fetchImpl?: FetchLike; now?: Date; signal?: AbortSignal } = {},
): Promise<NtfyDeliveryOutcome> {
  const now = options.now ?? new Date();
  try {
    const response = await requestProvider(request.url, {
      method: 'POST',
      signal: options.signal,
      headers: request.headers,
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
      return response.status >= 200 && response.status < 300
        ? {
          state: 'unknown',
          retryable: false,
          safeErrorCode: body.reason === 'too_large' ? 'response_too_large' : 'malformed_receipt',
        }
        : rejection(response.status, retryAfterMilliseconds(response, now));
    }
    if (response.status < 200 || response.status >= 300) {
      return rejection(response.status, retryAfterMilliseconds(response, now));
    }
    try {
      const receipt = JSON.parse(body.text) as { id?: unknown };
      if (!receipt || typeof receipt !== 'object' || !validMessageId(receipt.id)) {
        return { state: 'unknown', retryable: false, safeErrorCode: 'malformed_receipt' };
      }
      return {
        state: 'confirmed',
        retryable: false,
        receipt: { provider: 'ntfy', messageId: receipt.id, acceptedAt: now.toISOString() },
      };
    } catch {
      return { state: 'unknown', retryable: false, safeErrorCode: 'malformed_receipt' };
    }
  } catch (error) {
    if (retryableTransportFailure(error)) {
      return { state: 'failed', retryable: true, safeErrorCode: 'connection_unavailable' };
    }
    return { state: 'unknown', retryable: false, safeErrorCode: 'transport_ambiguous' };
  }
}
