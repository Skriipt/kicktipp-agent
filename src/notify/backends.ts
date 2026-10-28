/** Notification destinations are configured locally, never by remote MCP calls. */
export type NotificationChannel =
  | { id: string; kind: 'webhook'; url: string }
  | { id: string; kind: 'discord'; url: string }
  | { id: string; kind: 'telegram'; botToken: string; chatId: string };

export interface NotificationPayload {
  summary: string;
  [key: string]: unknown;
}

export class NotificationError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'NotificationError';
  }
}

function required(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message);
  return value.trim();
}

/** Errors deliberately exclude URLs and bot tokens, which are credentials. */
export function validateChannel(value: unknown): NotificationChannel {
  if (!value || typeof value !== 'object') throw new Error('Notification channel must be an object.');
  const row = value as Record<string, unknown>;
  const id = required(row.id, 'Notification channel needs an id.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
    throw new Error('Notification channel id must use 1–64 letters, digits, underscores or hyphens.');
  }
  if (row.kind === 'telegram') {
    const botToken = required(row.botToken, 'Telegram needs a bot token from BotFather.');
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) throw new Error('Telegram bot token has an invalid format.');
    const chatId = required(row.chatId, 'Telegram needs a chat id. Start a conversation with your bot first.');
    if (!/^(?:-?\d+|@[A-Za-z0-9_]+)$/.test(chatId)) throw new Error('Telegram chat id has an invalid format.');
    return { id, kind: 'telegram', botToken, chatId };
  }
  if (row.kind !== 'webhook' && row.kind !== 'discord') {
    throw new Error('Notification kind must be webhook, discord or telegram.');
  }
  const address = required(row.url, 'Notification channel needs a URL.');
  let url: URL;
  try { url = new URL(address); } catch { throw new Error('Notification URL must be an absolute HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Notification URL must use HTTP(S), without user information or a fragment.');
  }
  if (row.kind === 'discord' && (
    url.protocol !== 'https:' ||
    !['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'].includes(url.hostname) ||
    !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
  )) {
    throw new Error('Discord needs the webhook URL copied from channel settings → Integrations → Webhooks.');
  }
  return { id, kind: row.kind, url: url.href };
}

function limitedText(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit - 1).join('') + '…';
}

/** One POST per attempt. The scheduler decides when a failed channel is retried. */
export async function sendNotification(
  channel: NotificationChannel,
  payload: NotificationPayload,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const validated = validateChannel(channel);
  let target: string;
  let body: unknown;
  if (validated.kind === 'telegram') {
    target = `https://api.telegram.org/bot${validated.botToken}/sendMessage`;
    body = {
      chat_id: validated.chatId,
      text: limitedText(payload.summary, 4096),
      link_preview_options: { is_disabled: true },
    };
  } else if (validated.kind === 'discord') {
    const url = new URL(validated.url);
    // Without wait, Discord may return 204 even when a message was not saved.
    url.searchParams.set('wait', 'true');
    target = url.href;
    body = { content: limitedText(payload.summary, 2000), allowed_mentions: { parse: [] } };
  } else {
    target = validated.url;
    body = payload;
  }

  try {
    const response = await (deps.fetchImpl ?? fetch)(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      let seconds = Number(response.headers.get('retry-after'));
      if (validated.kind === 'telegram') {
        // Telegram normally places its rate-limit delay in the JSON envelope.
        const data = await response.json().catch(() => null) as { parameters?: { retry_after?: number } } | null;
        if (typeof data?.parameters?.retry_after === 'number') seconds = data.parameters.retry_after;
      } else {
        await response.body?.cancel();
      }
      throw new NotificationError(
        `${validated.kind} delivery failed (HTTP ${response.status}).`,
        Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 86_400_000) : undefined,
      );
    }
    if (validated.kind === 'telegram') {
      const data = await response.json() as { ok?: boolean; parameters?: { retry_after?: number } };
      if (data.ok !== true) {
        throw new NotificationError('Telegram did not confirm delivery.',
          typeof data.parameters?.retry_after === 'number'
            ? Math.min(Math.max(data.parameters.retry_after, 0) * 1000, 86_400_000)
            : undefined);
      }
    } else {
      await response.body?.cancel();
    }
  } catch (error) {
    if (error instanceof NotificationError) throw error;
    // fetch errors can contain the complete URL, including a bot/webhook token.
    const timedOut = error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
    throw new NotificationError(`${validated.kind} delivery ${timedOut ? 'timed out' : 'failed; check connectivity and channel settings'}.`);
  }
}
