import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  enabledTools?: readonly string[];
  disabledTools?: readonly string[];
}

export interface WriteSessionMcpConfigOptions {
	readonly workDir: string;
	readonly servers: readonly FacadeMcpServer[];
	readonly credentialsDir: string | undefined;
	/**
	 * Ephemeral credential snapshot supplied by the trusted orchestrator for a
	 * live config replacement. When present, it takes precedence over the
	 * Kubernetes Secret volume so kubelet projection latency cannot preserve a
	 * stale token in the active facade.
	 */
	readonly credentials?: Readonly<Record<string, string>>;
	/** Replace OCA-managed servers instead of merging an initial config. */
	readonly replace?: boolean;
}

export interface SessionMcpConfigSnapshot {
  readonly file: string;
  readonly content: string | undefined;
  readonly environment: readonly { readonly name: string; readonly value: string | undefined }[];
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
  const previousManagedServers =
    typeof existing['mcpServers'] === 'object' &&
    existing['mcpServers'] !== null &&
    !Array.isArray(existing['mcpServers'])
      ? (existing['mcpServers'] as Record<string, unknown>)
      : {};
  const existingServers = options.replace ? {} : previousManagedServers;

  const mapped: Record<string, McpServerConfigJson> = {};
  for (const server of options.servers) {
    const entry: McpServerConfigJson = {
      transport: server.type === 'sse' ? 'sse' : 'http',
      url: server.url,
      ...(server.enabledTools !== undefined ? { enabledTools: server.enabledTools } : {}),
      ...(server.disabledTools !== undefined ? { disabledTools: server.disabledTools } : {}),
    };
    const token = options.credentials === undefined
      ? await readCredential(options.credentialsDir, server.url)
      : options.credentials[server.url];
    if (token !== undefined) {
      const envVar = bearerEnvVarForServer(server.url);
      process.env[envVar] = token;
      entry.bearerTokenEnvVar = envVar;
    }
    mapped[server.name] = entry;
  }

  if (options.replace === true) {
    const activeCredentialVariables = new Set(
      Object.values(mapped)
        .map((server) => server.bearerTokenEnvVar)
        .filter((envVar): envVar is string => envVar !== undefined),
    );
    for (const envVar of managedBearerEnvVars(previousManagedServers)) {
      if (!activeCredentialVariables.has(envVar)) delete process.env[envVar];
    }
  }

  await mkdir(dir, { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ ...existing, mcpServers: { ...existingServers, ...mapped } }, null, 2)}\n`,
    'utf-8',
  );
}

// hydrateSessionMcpCredentials restores only OCA-managed bearer variables
// from the credential volume before a recovered journal Session is resumed.
// The persisted MCP config names an environment variable but never contains a
// credential value, so a new facade process must rebuild those variables.
export async function hydrateSessionMcpCredentials(
  workDir: string,
  credentialsDir: string | undefined,
): Promise<void> {
  const existing = await readSessionMcpConfig(workDir);
  const servers = mcpServersFromConfig(existing);
  for (const server of Object.values(servers)) {
    if (typeof server !== 'object' || server === null || Array.isArray(server)) continue;
    const entry = server as Record<string, unknown>;
    const url = entry['url'];
    const envVar = entry['bearerTokenEnvVar'];
    if (typeof url !== 'string' || typeof envVar !== 'string' || !isManagedBearerEnvVar(envVar)) continue;
    const token = await readCredential(credentialsDir, url);
    if (token === undefined) {
      delete process.env[envVar];
    } else {
      process.env[envVar] = token;
    }
  }
}

// snapshotSessionMcpConfig captures the exact file and every OCA-managed
// bearer variable a replacement may change. It is held in memory only so a
// rejected live reload can leave the active runtime configuration untouched.
export async function snapshotSessionMcpConfig(
  workDir: string,
  replacementServers: readonly FacadeMcpServer[],
): Promise<SessionMcpConfigSnapshot> {
  const file = sessionMcpConfigFile(workDir);
  let content: string | undefined;
  try {
    content = await readFile(file, 'utf-8');
  } catch {
    // A missing config is restored by removing the newly created replacement.
  }
  const existing = parseMcpConfig(content);
  const managed = new Set(managedBearerEnvVars(mcpServersFromConfig(existing)));
  for (const server of replacementServers) managed.add(bearerEnvVarForServer(server.url));
  return {
    file,
    content,
    environment: [...managed].sort().map((name) => ({ name, value: process.env[name] })),
  };
}

export async function restoreSessionMcpConfig(snapshot: SessionMcpConfigSnapshot): Promise<void> {
  if (snapshot.content === undefined) {
    await rm(snapshot.file, { force: true });
  } else {
    await mkdir(join(snapshot.file, '..'), { recursive: true });
    await writeFile(snapshot.file, snapshot.content, 'utf-8');
  }
  for (const variable of snapshot.environment) {
    if (variable.value === undefined) {
      delete process.env[variable.name];
    } else {
      process.env[variable.name] = variable.value;
    }
  }
}

async function readSessionMcpConfig(workDir: string): Promise<Record<string, unknown>> {
  try {
    return parseMcpConfig(await readFile(sessionMcpConfigFile(workDir), 'utf-8'));
  } catch {
    return {};
  }
}

function parseMcpConfig(content: string | undefined): Record<string, unknown> {
  if (content === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function mcpServersFromConfig(config: Record<string, unknown>): Record<string, unknown> {
  const servers = config['mcpServers'];
  return typeof servers === 'object' && servers !== null && !Array.isArray(servers)
    ? servers as Record<string, unknown>
    : {};
}

function sessionMcpConfigFile(workDir: string): string {
  return join(workDir, '.kimi-code', 'mcp.json');
}

function managedBearerEnvVars(servers: Record<string, unknown>): readonly string[] {
	return Object.values(servers).flatMap((server) => {
		if (typeof server !== 'object' || server === null || Array.isArray(server)) return [];
		const envVar = (server as Record<string, unknown>)['bearerTokenEnvVar'];
		return typeof envVar === 'string' && isManagedBearerEnvVar(envVar)
			? [envVar]
			: [];
	});
}

function isManagedBearerEnvVar(value: string): boolean {
  return /^OCA_MCP_BEARER_[0-9A-F]{16}$/.test(value);
}

/** Reads the mounted credential for a server URL (fixed-length hash file name). */
async function readCredential(
  credentialsDir: string | undefined,
  serverUrl: string,
): Promise<string | undefined> {
  if (credentialsDir === undefined) return undefined;
  try {
    const token = await readFile(
      join(credentialsDir, credentialFileName(serverUrl)),
      'utf-8',
    );
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

function credentialFileName(serverUrl: string): string {
  return `mcp-${createHash('sha256').update(serverUrl).digest('hex')}`;
}

/** Deterministic env var name for a server credential; never contains the URL. */
function bearerEnvVarForServer(serverUrl: string): string {
  const digest = createHash('sha256').update(serverUrl).digest('hex').slice(0, 16).toUpperCase();
  return `OCA_MCP_BEARER_${digest}`;
}
