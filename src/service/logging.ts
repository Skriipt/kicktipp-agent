import type { HealthLevel, HealthReason } from './health.js';
import { safeError, type SafeError } from './safe-error.js';

export type LogFormat = 'text' | 'json';
type CheckOutcome = 'disabled' | 'no-open-deadline-group' | 'not-due' | 'satisfied' | 'notified' | 'already-processed' | 'interrupted' | 'unreliable';

export type ServiceLogEvent =
  | { event: 'service_started'; at: string; jobId: string; health: HealthLevel }
  | { event: 'service_stopped'; at: string; jobId: string }
  | { event: 'check_completed'; at: string; jobId: string; durationMs: number; reliable: boolean; outcome?: CheckOutcome; error?: SafeError }
  | { event: 'delivery_transition'; at: string; jobId: string; deliveryId: string; targetId: string; provider: string; from: string; to: string; attemptCount: number; missingCount: number; nextRetryAt?: string; error?: SafeError }
  | { event: 'health_transition'; at: string; jobId: string; from: HealthLevel; to: HealthLevel; reasons: HealthReason[] };

export interface ServiceLogger {
  log(event: ServiceLogEvent): void;
}

function jsonEvent(event: ServiceLogEvent): Record<string, unknown> {
  const error = 'error' in event && event.error ? safeError(event.error.code) : undefined;
  switch (event.event) {
    case 'service_started':
      return { event: event.event, at: event.at, jobId: event.jobId, health: event.health };
    case 'service_stopped':
      return { event: event.event, at: event.at, jobId: event.jobId };
    case 'check_completed':
      return {
        event: event.event,
        at: event.at,
        jobId: event.jobId,
        durationMs: event.durationMs,
        reliable: event.reliable,
        ...(event.outcome ? { outcome: event.outcome } : {}),
        ...(error ? { error } : {}),
      };
    case 'delivery_transition':
      return {
        event: event.event,
        at: event.at,
        jobId: event.jobId,
        deliveryId: event.deliveryId,
        targetId: event.targetId,
        provider: event.provider,
        from: event.from,
        to: event.to,
        attemptCount: event.attemptCount,
        missingCount: event.missingCount,
        ...(event.nextRetryAt ? { nextRetryAt: event.nextRetryAt } : {}),
        ...(error ? { error } : {}),
      };
    case 'health_transition':
      return { event: event.event, at: event.at, jobId: event.jobId, from: event.from, to: event.to, reasons: event.reasons };
  }
}

/** Serialize only explicitly safe fields; caller-owned objects and exceptions are never spread. */
export function createServiceLogger(
  format: LogFormat,
  output: { stdout?: (line: string) => void; stderr?: (line: string) => void } = {},
): ServiceLogger {
  const stdout = output.stdout ?? console.log;
  const stderr = output.stderr ?? console.error;
  return {
    log(event) {
      const value = jsonEvent(event);
      const write = event.event === 'check_completed' && !event.reliable ? stderr : stdout;
      write(format === 'json'
        ? JSON.stringify(value)
        : Object.entries(value).map(([key, field]) => `${key}=${typeof field === 'object' ? JSON.stringify(field) : field}`).join(' '));
    },
  };
}
