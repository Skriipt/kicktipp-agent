import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { sendNotification, NotificationError, type NotificationChannel } from '../src/notify/backends.js';

const hook: NotificationChannel = { id: 'hook', kind: 'webhook', url: 'http://example.test/private-secret' };
const discord: NotificationChannel = { id: 'discord', kind: 'discord', url: 'https://discord.com/api/webhooks/123/private-secret' };
const telegram: NotificationChannel = { id: 'telegram', kind: 'telegram', botToken: '123:private-secret', chatId: '-100123' };

function recorder(response: () => Response = () => new Response('{}', { status: 200 })) {
  const fetchImpl = vi.fn(async () => response());
  return { fetchImpl: fetchImpl as unknown as typeof fetch, spy: fetchImpl };
}

function request(spy: ReturnType<typeof recorder>['spy']) {
  const args = spy.mock.calls[0] as unknown as [string, RequestInit];
  return { url: args[0], init: args[1], body: JSON.parse(String(args[1].body)) };
}

describe('notification delivery', () => {
  it('posts the structured payload to a generic webhook without redirects', async () => {
    const { fetchImpl, spy } = recorder();
    await sendNotification(hook, { summary: 'Missing tips', event: 'missing_tips', matches: [{ home: 'Bayern' }] }, { fetchImpl });
    expect(request(spy)).toMatchObject({
      url: hook.url, init: { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' } },
      body: { summary: 'Missing tips', event: 'missing_tips', matches: [{ home: 'Bayern' }] },
    });
  });

  it('formats Discord content, disables mentions and requests confirmed execution', async () => {
    const { fetchImpl, spy } = recorder();
    await sendNotification(discord, { summary: '@everyone needs a tip' }, { fetchImpl });
    expect(request(spy)).toMatchObject({
      url: discord.url + '?wait=true',
      body: { content: '@everyone needs a tip', allowed_mentions: { parse: [] } },
    });
    expect(request(spy).body).not.toHaveProperty('summary');
  });

  it('formats Telegram sendMessage without Markdown or link previews', async () => {
    const { fetchImpl, spy } = recorder(() => new Response('{"ok":true,"result":{}}'));
    await sendNotification(telegram, { summary: 'A_B vs <C>' }, { fetchImpl });
    expect(request(spy)).toMatchObject({
      url: 'https://api.telegram.org/bot123:private-secret/sendMessage',
      body: { chat_id: '-100123', text: 'A_B vs <C>', link_preview_options: { is_disabled: true } },
    });
    expect(request(spy).body).not.toHaveProperty('parse_mode');
  });

  it('limits provider text to the accepted length', async () => {
    const a = recorder();
    const b = recorder(() => new Response('{"ok":true}'));
    await sendNotification(discord, { summary: 'x'.repeat(5000) }, a);
    await sendNotification(telegram, { summary: 'x'.repeat(5000) }, b);
    expect(request(a.spy).body.content.length).toBe(2000);
    expect(request(b.spy).body.text.length).toBe(4096);
  });

  it('rejects Telegram responses that do not confirm delivery', async () => {
    await expect(sendNotification(telegram, { summary: 'Test' }, recorder(() => new Response('{"ok":false}'))))
      .rejects.toThrow('did not confirm');
  });

  it('preserves Retry-After but never echoes the webhook URL or response body', async () => {
    const attempt = sendNotification(hook, { summary: 'Test' }, recorder(() => new Response('private-secret', {
      status: 429, headers: { 'Retry-After': '120' },
    })));
    await expect(attempt).rejects.toMatchObject({ retryAfterMs: 120000 });
    await expect(attempt).rejects.not.toThrow('private-secret');
  });

  it('redacts fetch errors containing credentials', async () => {
    const fetchImpl = (async () => { throw new Error('Cannot connect to /bot123:private-secret/sendMessage'); }) as typeof fetch;
    const attempt = sendNotification(telegram, { summary: 'Test' }, { fetchImpl });
    await expect(attempt).rejects.toBeInstanceOf(NotificationError);
    await expect(attempt).rejects.not.toThrow('private-secret');
  });

  it('reads Telegram rate limits from the API envelope', async () => {
    await expect(sendNotification(telegram, { summary: 'Test' }, recorder(() => new Response(
      '{"ok":false,"parameters":{"retry_after":300}}', { status: 429 },
    )))).rejects.toMatchObject({ retryAfterMs: 300000 });
  });

  it('times out an actual stalled local endpoint', async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      await expect(sendNotification({ id: 'slow', kind: 'webhook', url: `http://127.0.0.1:${address.port}` },
        { summary: 'Test' }, { timeoutMs: 30 })).rejects.toThrow('timed out');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
