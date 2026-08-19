import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { PermissionPolicyType } from './facade-types';

const PROFILE_POLICY_STATE_VERSION = 1;
const PROFILE_POLICY_STATE_FILE = '.oca-facade/profile-permission-policies.json';

export interface ProfilePolicyState {
  readonly mainProfile: string;
  readonly policies: ReadonlyMap<string, ReadonlyMap<string, PermissionPolicyType>>;
}

export async function writeProfilePolicyState(workDir: string, state: ProfilePolicyState): Promise<void> {
  const file = profilePolicyStateFile(workDir);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  const profiles = Object.fromEntries(
    [...state.policies.entries()].map(([profile, policies]) => [profile, Object.fromEntries(policies)]),
  );
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ version: PROFILE_POLICY_STATE_VERSION, main_profile: state.mainProfile, profiles })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readProfilePolicyState(workDir: string): Promise<ProfilePolicyState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(profilePolicyStateFile(workDir), 'utf8'));
  } catch (error) {
    throw new Error('persisted profile permission policy state is unavailable', { cause: error });
  }
  if (!isRecord(parsed) || parsed['version'] !== PROFILE_POLICY_STATE_VERSION || typeof parsed['main_profile'] !== 'string' || parsed['main_profile'].length === 0 || !isRecord(parsed['profiles'])) {
    throw new Error('persisted profile permission policy state is invalid');
  }
  const policies = new Map<string, ReadonlyMap<string, PermissionPolicyType>>();
  for (const [profile, entries] of Object.entries(parsed['profiles'])) {
    if (profile.length === 0 || !isRecord(entries)) {
      throw new Error('persisted profile permission policy state is invalid');
    }
    const profilePolicies = new Map<string, PermissionPolicyType>();
    for (const [tool, policy] of Object.entries(entries)) {
      if (tool.length === 0 || !isPermissionPolicy(policy)) {
        throw new Error('persisted profile permission policy state is invalid');
      }
      profilePolicies.set(tool, policy);
    }
    policies.set(profile, profilePolicies);
  }
  if (!policies.has(parsed['main_profile'])) {
    throw new Error('persisted profile permission policy state is invalid');
  }
  return { mainProfile: parsed['main_profile'], policies };
}

function profilePolicyStateFile(workDir: string): string {
  return join(workDir, PROFILE_POLICY_STATE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPermissionPolicy(value: unknown): value is PermissionPolicyType {
  return value === 'always_allow' || value === 'always_ask' || value === 'always_deny';
}
