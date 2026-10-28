import { applyServiceConfig, profileServiceConfig, resolveServiceProfile, type ServiceConfig } from './settings.js';
import { resolveBaseUrl, setUrlBase } from '../url.js';

/** Public discovery data: credentials and notification destinations stay local. */
export function describeProfiles(config: ServiceConfig | null) {
  return config?.profiles.map(({ id, name, account, readOnly }) => ({
    id, name, community: account.community, player: account.player ?? null,
    site: account.site, read_only: readOnly,
  })) ?? [];
}

/**
 * The existing core reads process settings. Activate them only inside the shared
 * Kicktipp queue, for the entire operation, including retries and write read-back.
 * Callers must hold that queue; this helper never nests another queue operation.
 */
export function createProfileAccess(getConfig: () => ServiceConfig | null) {
  return {
    profiles: () => describeProfiles(getConfig()),
    async withProfile<T>(id: string | undefined, operation: () => Promise<T>): Promise<T> {
      const config = getConfig();
      if (!config) throw new Error('Setup required: add a profile in the web interface.');
      const profile = resolveServiceProfile(config, id);
      applyServiceConfig(profileServiceConfig(config, profile), profile.id);
      setUrlBase(resolveBaseUrl());
      return operation();
    },
  };
}
