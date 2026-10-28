import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveDataSource } from '../src/tui/app/live-source.js';
import { Page } from '../src/http/page.js';
import { CookieJar } from '../src/http/cookie-jar.js';

const mocked = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('../src/browser.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/browser.js')>(), launchBrowser: mocked.launch,
}));
afterEach(() => { vi.unstubAllEnvs(); mocked.launch.mockReset(); });

describe('TUI session lifecycle', () => {
  it('shares one pending login between simultaneous screen reads', async () => {
    vi.stubEnv('KICKTIPP_COMMUNITY', 'c');
    const page = new Page(new CookieJar(), async () => new Response('<div id="kicktipp-content"></div>'));
    let ready!: (page: Page) => void;
    mocked.launch.mockImplementation(() => new Promise<Page>(resolve => { ready = resolve; }));
    const source = new LiveDataSource();
    const first = source.bets(1);
    const second = source.bets(2);
    expect(mocked.launch).toHaveBeenCalledTimes(1);
    ready(page);
    await Promise.all([first, second]);
    await source.close();
    expect(page.isClosed()).toBe(true);
  });

  it('disposes a login which completes after the TUI has closed', async () => {
    vi.stubEnv('KICKTIPP_COMMUNITY', 'c');
    const page = new Page(new CookieJar(), async () => new Response('unused'));
    let ready!: (page: Page) => void;
    mocked.launch.mockImplementation(() => new Promise<Page>(resolve => { ready = resolve; }));
    const source = new LiveDataSource();
    const pending = source.bets(1);
    const failed = expect(pending).rejects.toThrow(/closed/);
    const closing = source.close();
    ready(page);
    await Promise.all([failed, closing]);
    expect(page.isClosed()).toBe(true);
    await expect(source.bets(2)).rejects.toThrow(/closed/);
    expect(mocked.launch).toHaveBeenCalledTimes(1);
  });
});
