import { describe, expect, it } from 'vitest';
import { deliverWebhook } from '../src/service/delivery.js';
import { deliverDiscord } from '../src/service/discord.js';
import { deliverTelegram } from '../src/service/telegram.js';
import { deliverNtfy } from '../src/service/ntfy.js';

const START = new Date('2026-09-04T11:00:00.000Z');
const request = { url: 'https://provider.test/hook', headers: {}, body: '{}' };
const adapters = {
  webhook: (options: Parameters<typeof deliverDiscord>[1]) => deliverWebhook(
    { resolved: { url: request.url, headers: {} }, body: '{}' },
    { notificationId: 'notification', deliveryId: 'delivery' }, options),
  discord: (options: Parameters<typeof deliverDiscord>[1]) => deliverDiscord(request, options),
  telegram: (options: Parameters<typeof deliverDiscord>[1]) => deliverTelegram(request, options),
  ntfy: (options: Parameters<typeof deliverDiscord>[1]) => deliverNtfy(request, options),
};

describe('provider response clocks', () => {
  it.each(Object.entries(adapters))('%s interprets HTTP-date Retry-After at response reception', async (_name, deliver) => {
    let current = START;
    const result = await deliver({
      now: START,
      clock: { now: () => current },
      fetchImpl: async () => {
        current = new Date('2026-09-04T11:00:12.000Z');
        return new Response(null, { status: 429, headers: { 'Retry-After': 'Fri, 04 Sep 2026 11:01:12 GMT' } });
      },
    });
    expect(result).toMatchObject({ state: 'failed', retryable: true, retryAfterMilliseconds: 60_000 });
  });
});
