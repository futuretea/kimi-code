import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FacadeMcpServer } from './facade-types';

/**
 * Minimal session server-config shape written for the runtime's config loader
 * (`agent-core/src/mcp/config-loader.ts`): `<workDir>/.kimi-code/mcp.json`
 * holding `{ "mcpServers": { <name>: <entry> } }`. Declared locally on purpose
 * — the facade package only depends on the sdk.
 */
interface McpServerConfigJson {
  transport: 'http' | 'sse';
  url: string;
  bearerTokenEnvVar?: string;
}

export interface WriteSessionMcpConfigOptions {
  readonly workDir: string;
  readonly servers: readonly FacadeMcpServer[];
  readonly credentialsDir: string | undefined;
}

/**
 * Writes the session's external server config where the runtime's config
 * loader reads it (`<workDir>/.kimi-code/mcp.json`, project-local layer that
 * wins over the user-global and project-root files), merging with any
 * existing file. Credentials mounted in the credentials dir are referenced
 * indirectly through `bearerTokenEnvVar` so no token is persisted on disk.
 */
export async function writeSessionMcpConfig(
  options: WriteSessionMcpConfigOptions,
): Promise<void> {
  const dir = join(options.workDir, '.kimi-code');
  const file = join(dir, 'mcp.json');
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf-8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable file: start from an empty config.
  }
  const existingServers =
    typeof existing['mcpServers'] === 'object' &&
    existing['mcpServers'] !== null &&
    !Array.isArray(existing['mcpServers'])
      ? (existing['mcpServers'] as Record<string, unknown>)
      : {};

  const mapped: Record<string, McpServerConfigJson> = {};
  for (const server of options.servers) {
    const entry: McpServerConfigJson = {
      transport: server.type === 'sse' ? 'sse' : 'http',
      url: server.url,
    };
    const token = await readCredential(options.credentialsDir, server.url);
    if (token !== undefined) {
      const envVar = bearerEnvVarForServer(server.url);
      process.env[envVar] = token;
      entry.bearerTokenEnvVar = envVar;
    }
    mapped[server.name] = entry;
  }

  await mkdir(dir, { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ ...existing, mcpServers: { ...existingServers, ...mapped } }, null, 2)}\n`,
    'utf-8',
  );
}

/** Reads the mounted credential for a server URL (base64url file name). */
async function readCredential(
  credentialsDir: string | undefined,
  serverUrl: string,
): Promise<string | undefined> {
  if (credentialsDir === undefined) return undefined;
  try {
    const token = await readFile(
      join(credentialsDir, Buffer.from(serverUrl).toString('base64url')),
      'utf-8',
    );
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Deterministic env var name for a server credential; never contains the URL. */
function bearerEnvVarForServer(serverUrl: string): string {
  const digest = createHash('sha256').update(serverUrl).digest('hex').slice(0, 16).toUpperCase();
  return `OCA_MCP_BEARER_${digest}`;
}
