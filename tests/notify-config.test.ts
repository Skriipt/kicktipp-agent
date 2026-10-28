import { describe, it, expect } from 'vitest';
import { validateChannel } from '../src/notify/backends.js';

describe('notification destination validation', () => {
  it('normalizes a generic HTTP webhook without inventing a destination', () => {
    expect(validateChannel({ id: 'home', kind: 'webhook', url: ' http://home.example/hook ' })).toEqual({
      id: 'home', kind: 'webhook', url: 'http://home.example/hook',
    });
    expect(() => validateChannel({ id: 'home', kind: 'webhook' })).toThrow('needs a URL');
  });

  it('accepts the Discord URL copied from channel integrations', () => {
    expect(validateChannel({ id: 'discord', kind: 'discord', url: 'https://discord.com/api/webhooks/123/token_abc' })).toMatchObject({ kind: 'discord' });
    expect(() => validateChannel({ id: 'discord', kind: 'discord', url: 'https://example.com/api/webhooks/123/secret' })).toThrow('Discord needs');
    expect(() => validateChannel({ id: 'discord', kind: 'discord', url: 'http://discord.com/api/webhooks/123/secret' })).toThrow('Discord needs');
  });

  it('accepts personal, group and channel Telegram destinations', () => {
    for (const chatId of ['123', '-100123', '@my_channel']) {
      expect(validateChannel({ id: 'telegram', kind: 'telegram', botToken: '123:secret', chatId })).toMatchObject({ chatId });
    }
    expect(() => validateChannel({ id: 'telegram', kind: 'telegram', botToken: 'secret', chatId: '123' })).toThrow('token has an invalid format');
    expect(() => validateChannel({ id: 'telegram', kind: 'telegram', botToken: '123:secret', chatId: '' })).toThrow('Start a conversation');
  });

  it('rejects desktop/command backends and unsupported URL schemes', () => {
    for (const kind of ['desktop', 'command']) {
      expect(() => validateChannel({ id: 'old', kind })).toThrow('must be webhook, discord or telegram');
    }
    for (const url of ['file:///tmp/token', 'https://user:secret@example.com/hook', 'https://example.com/hook#secret']) {
      expect(() => validateChannel({ id: 'hook', kind: 'webhook', url })).toThrow('without user information');
    }
  });

  it('does not leak invalid destinations in error messages', () => {
    try { validateChannel({ id: 'hook', kind: 'webhook', url: 'not-a-url-secret' }); }
    catch (error) { expect(String(error)).not.toContain('not-a-url-secret'); }
  });
});
