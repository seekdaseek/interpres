/**
 * Per-URL cache of a converted catalog.
 *
 * `/api/mcp/connect` costs a round trip to a stranger's server plus a full
 * conversion, and the browser asks for the same URL on every reconnect. Ten
 * minutes, bounded entries, oldest evicted first.
 */
import type { CatalogConversion, McpServerInfo } from '@interpres/core';
import { buildNameMap, convertCatalog } from '@interpres/core';
import { probeServer } from './mcp.ts';
import type { Transport } from './mcp.ts';
import { FIND_TOOLS_NAME } from '@interpres/core';
import { config } from './config.ts';

export type Catalog = {
  url: string;
  transport: Transport;
  server: McpServerInfo | undefined;
  instructions?: string;
  conversion: CatalogConversion;
  /** Voice Agent name -> MCP name, which `tools/call` needs. */
  nameMap: Map<string, string>;
  fetchedAt: number;
};

const cache = new Map<string, { catalog: Catalog; expires: number }>();

export function cacheStats(): { entries: number } {
  return { entries: cache.size };
}

export function invalidate(url?: string): void {
  if (url === undefined) cache.clear();
  else cache.delete(url);
}

export async function getCatalog(
  url: string,
  opts: { force?: boolean; now?: number } = {},
): Promise<{ catalog: Catalog; cached: boolean }> {
  const now = opts.now ?? Date.now();
  const hit = cache.get(url);
  if (!opts.force && hit !== undefined && hit.expires > now) {
    return { catalog: hit.catalog, cached: true };
  }

  const connection = await probeServer(url);
  // `find_tools` is ours, so a server tool of the same name must be renamed
  // rather than silently shadowing the meta-tool.
  const conversion = convertCatalog(connection.tools, { reserved: [FIND_TOOLS_NAME] });
  const catalog: Catalog = {
    url,
    transport: connection.transport,
    server: connection.serverInfo,
    instructions: connection.instructions,
    conversion,
    nameMap: buildNameMap(conversion.converted),
    fetchedAt: now,
  };

  if (cache.size >= config.limits.catalogCacheEntries) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(url, { catalog, expires: now + config.limits.catalogCacheMs });
  return { catalog, cached: false };
}
