import { z } from 'zod';
import { sourceSchema } from './model.js';
import { ResearchPaused, type ResearchProvider } from './research.js';

const policySchema = z.object({
  mode: z.literal('keyless'),
  web: z.object({
    backend: z.literal('firecrawl'),
    search_backend: z.literal('firecrawl'),
    extract_backend: z.literal('firecrawl'),
    use_gateway: z.literal(false),
    keyless_fallback: z.literal(false),
    keyless_rescue: z.literal(false),
    cache_enabled: z.literal(false),
  }),
});
const responseSchema = z.object({
  backend: z.literal('firecrawl'), mode: z.literal('keyless'),
  status: z.number().int(), data: z.unknown(),
  rescued_from: z.never().optional(),
});

/** Application-supplied Hermes bridge, isolated per fixture. policy must inspect
 * effective routing (e.g. the healthcheck), not echo the example configuration.
 * request must report the actual backend/mode/status, including error responses.
 * For open, data is Source attributed from the extracted original by the adapter.
 * No live transport, credentials or fallback are implemented here. */
export interface HermesFirecrawlBridge {
  policy(signal: AbortSignal): Promise<unknown>;
  request(operation: 'search' | 'open', value: string, signal: AbortSignal): Promise<unknown>;
}

export function freeFirecrawlSession(
  bridge: HermesFirecrawlBridge, investigate: ResearchProvider['investigate'],
): ResearchProvider {
  const request = async (operation: 'search' | 'open', value: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!policySchema.safeParse(await bridge.policy(signal)).success) throw new ResearchPaused('backend_changed');
    signal.throwIfAborted();
    const response = responseSchema.safeParse(await bridge.request(operation, value, signal));
    signal.throwIfAborted();
    if (!response.success) throw new ResearchPaused('backend_changed');
    if (response.data.status === 402) throw new ResearchPaused('quota_exhausted');
    if (response.data.status === 429) throw new ResearchPaused('rate_limited');
    if (response.data.status !== 200) throw new Error('Firecrawl provider failure');
    return response.data.data;
  };
  return {
    investigate,
    search: async (query, signal) => z.array(z.url()).parse(await request('search', query, signal)),
    open: async (url, signal) => sourceSchema.parse(await request('open', url, signal)),
  };
}
