import { launchBrowser, type FetchLike, type Page } from './browser.js';
import { AuthError } from './core.js';
import {
  fetchReminderCapability,
  type ReminderCapability,
} from './reminder-capability.js';

export interface ScopedClientOptions {
  profileId: string;
  communityId: string;
  /** Injection point for tests. */
  fetchImpl?: FetchLike;
}

/** A Kicktipp client pinned to one Auth Profile and Community. */
export class ScopedKicktippClient {
  readonly profileId: string;
  readonly communityId: string;
  private readonly fetchImpl?: FetchLike;

  constructor(options: ScopedClientOptions) {
    if (!options.profileId.trim()) throw new Error('Auth Profile ID is required.');
    if (!options.communityId.trim()) throw new Error('Community Reference is required.');
    this.profileId = options.profileId;
    this.communityId = options.communityId;
    this.fetchImpl = options.fetchImpl;
  }

  /** Run one read in an independent session, refreshing auth once if needed. */
  async read<T>(operation: (page: Page, communityId: string) => Promise<T>): Promise<T> {
    let page = await launchBrowser({ profileId: this.profileId, fetchImpl: this.fetchImpl });
    try {
      try {
        return await operation(page, this.communityId);
      } catch (error) {
        if (!(error instanceof AuthError)) throw error;
        await page.close();
        page = await launchBrowser({ profileId: this.profileId, fetchImpl: this.fetchImpl });
        return await operation(page, this.communityId);
      }
    } finally {
      await page.close();
    }
  }

  /** Return a complete Reminder Snapshot or a safe capability diagnostic. */
  async getReminderSnapshot(matchday?: number): Promise<ReminderCapability> {
    return this.read((page, communityId) =>
      fetchReminderCapability(page, this.profileId, communityId, matchday),
    );
  }
}

export function createScopedClient(options: ScopedClientOptions): ScopedKicktippClient {
  return new ScopedKicktippClient(options);
}
