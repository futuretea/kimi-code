import { z } from 'zod';

import { resolveAgentProfiles } from './resolve';
import { RawAgentProfileSchema, type RawAgentProfile, type ResolvedAgentProfile } from './types';

/**
 * Serializable profile registry owned by one Session. The runtime stores this
 * exact input in session metadata so resuming a Session does not re-resolve
 * profiles from mutable process-wide configuration.
 */
export interface SessionAgentProfileConfig {
  readonly mainProfile: string;
  readonly profiles: readonly RawAgentProfile[];
  /** Maximum live Agent instances in this Session, including the main Agent. */
  readonly maxAgents?: number;
}

export interface ResolvedSessionAgentProfiles {
  readonly config: SessionAgentProfileConfig;
  readonly mainProfile: ResolvedAgentProfile;
  readonly profiles: Readonly<Record<string, ResolvedAgentProfile>>;
}

const SessionAgentProfileConfigSchema = z
  .object({
    mainProfile: z.string().min(1),
    profiles: z.array(RawAgentProfileSchema),
    maxAgents: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Parses a serializable registry into the profile renderers used by a Session.
 * File-backed profile templates are intentionally excluded: a persisted
 * Session must carry its complete prompt text rather than depend on a path
 * whose contents can change before it resumes.
 */
export function resolveSessionAgentProfiles(
  input: SessionAgentProfileConfig,
): ResolvedSessionAgentProfiles {
  const parsed = SessionAgentProfileConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error('Invalid session agent profile registry');
  }
  if (parsed.data.profiles.some((profile) => profile.systemPromptPath !== undefined)) {
    throw new Error('Session agent profiles must use systemPromptTemplate, not systemPromptPath');
  }

  const profiles = resolveAgentProfiles(parsed.data.profiles);
  const mainProfile = profiles[parsed.data.mainProfile];
  if (mainProfile === undefined) {
    throw new Error(`Session main agent profile "${parsed.data.mainProfile}" was not found`);
  }
  return {
    config: {
      mainProfile: parsed.data.mainProfile,
      profiles: parsed.data.profiles,
      ...(parsed.data.maxAgents !== undefined ? { maxAgents: parsed.data.maxAgents } : {}),
    },
    mainProfile,
    profiles,
  };
}
