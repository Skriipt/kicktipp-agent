export interface SafeError {
  code: string;
  safeMessage: string;
  category: 'configuration' | 'state' | 'authentication' | 'capability' | 'network' | 'provider' | 'internal';
  retryable: boolean;
}

const KNOWN_PROVIDER_CODES = new Set([
  'authentication_failed',
  'connection_unavailable',
  'interrupted_attempt',
  'invalid_target',
  'job_disabled',
  'malformed_receipt',
  'malformed_response',
  'payload_too_large',
  'permission_denied',
  'provider_5xx',
  'provider_rejected',
  'rate_limited',
  'redirect_refused',
  'response_too_large',
  'retry_budget_exhausted',
  'retry_deadline_reached',
  'retry_validation_failed',
  'superseded_by_later_stage',
  'target_changed',
  'temporary_rejection',
  'transport_ambiguous',
  'unsupported_provider',
]);

/** Convert persisted, bounded error codes into the only error shape public surfaces may emit. */
export function safeError(code: string | undefined): SafeError | undefined {
  if (!code) return undefined;
  if (code === 'service_configuration_unreadable') {
    return { code, safeMessage: 'Service configuration is not reliably readable.', category: 'configuration', retryable: false };
  }
  if (code === 'service_state_unreadable') {
    return { code, safeMessage: 'Service State is not reliably readable.', category: 'state', retryable: false };
  }
  if (code === 'kicktipp_auth_unavailable') {
    return { code, safeMessage: 'The configured Auth Profile is unavailable.', category: 'authentication', retryable: false };
  }
  if (code.startsWith('reminder_capability_')) {
    return { code: 'reminder_capability_unavailable', safeMessage: 'Reminder Capability is unavailable.', category: 'capability', retryable: false };
  }
  if (code === 'kicktipp_network_failure') {
    return { code, safeMessage: 'A temporary Kicktipp network operation failed.', category: 'network', retryable: true };
  }
  if (code === 'kicktipp_operation_failure') {
    return { code, safeMessage: 'A Kicktipp operation failed.', category: 'capability', retryable: true };
  }
  if (KNOWN_PROVIDER_CODES.has(code)) {
    return {
      code,
      safeMessage: 'A Notification Target operation did not complete normally.',
      category: 'provider',
      retryable: ['connection_unavailable', 'rate_limited', 'temporary_rejection'].includes(code),
    };
  }
  return { code: 'service_operation_failure', safeMessage: 'A Service operation failed.', category: 'internal', retryable: false };
}

export function localReadSafeError(error: unknown): SafeError {
  const kind = error && typeof error === 'object' && 'kind' in error
    ? (error as { kind?: string }).kind
    : undefined;
  return safeError(kind === 'configuration' ? 'service_configuration_unreadable' : 'service_state_unreadable')!;
}
