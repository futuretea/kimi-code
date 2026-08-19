import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { z } from 'zod';

import { FacadeError, isFacadeError } from '../errors';
import type {
  FacadeCreateConfig,
	FacadeResource,
	FacadeMemorySyncResource,
  FacadeSessionConfig,
  FacadeToolEntry,
} from '../facade-types';

import type { RouteContext } from './context';
import { defineRoute } from './define-route';
import { MAX_SESSION_SKILLS, MAX_SKILL_ARCHIVE_BYTES, parseSessionCreateMultipart } from '../session-create-multipart';

/**
 * Session lifecycle routes: create / resume / interrupt / cancel. The wire
 * schema is snake_case (contract); it is mapped onto the camelCase internal
 * config types at the boundary.
 */

const permissionPolicySchema = z.object({
  type: z.enum(['always_allow', 'always_ask', 'always_deny']),
}).strict();

const toolConfigSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  permission_policy: permissionPolicySchema.optional(),
}).strict();

const agentToolsetSchema = z.object({
  type: z.literal('agent_toolset_20260401'),
  enabled_tools: z.array(z.string()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
  configs: z.array(toolConfigSchema).optional(),
}).strict();

const browserToolsetSchema = z.object({
  type: z.literal('browser_toolset_20260714'),
}).strict();

const mcpToolsetSchema = z.object({
  type: z.literal('mcp_toolset'),
  mcp_server_name: z.string().min(1),
  configs: z.array(toolConfigSchema).optional(),
}).strict();

const customToolSchema = z.object({
  type: z.literal('custom'),
  name: z.string().min(1),
  description: z.string(),
  input_schema: z.record(z.string(), z.unknown()),
}).strict();

const toolEntrySchema = z.discriminatedUnion('type', [
  agentToolsetSchema,
  browserToolsetSchema,
  mcpToolsetSchema,
  customToolSchema,
]);

const mcpServerSchema = z.object({
  type: z.literal('url'),
  name: z.string().min(1),
  url: z.string().min(1),
}).strict();

const githubCheckoutSchema = z.object({
	type: z.literal('branch'),
	name: z.string().min(1).refine((value) => !value.startsWith('-'), 'checkout name must not start with -'),
}).strict();

const resourceSchema = z.object({
	id: z.string().min(1),
	type: z.string().min(1),
	file_id: z.string().optional(),
	url: z.string().url().optional(),
  mount_path: z.string().optional(),
  pvc_path: z.string().min(1).optional(),
	download_url: z.string().url().optional(),
	size: z.number().int().nonnegative().optional(),
	authorization_token: z.string().min(1).optional(),
	checkout: githubCheckoutSchema.optional(),
	memory_store_id: z.string().min(1).optional(),
	access: z.enum(['read_only', 'read_write']).optional(),
	instructions: z.string().max(4096).optional(),
	memory_entries: z.array(z.object({
		id: z.string().min(1),
		path: z.string().min(1),
		content: z.string(),
		content_sha256: z.string().min(1),
	}).strict()).optional(),
}).strict();

const skillSchema = z.object({
  id: z.string().min(1),
  name: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  version: z.string().regex(/^[1-9][0-9]*$/),
	origin: z.enum(['managed', 'forward']),
  content_size: z.number().int().nonnegative().max(MAX_SKILL_ARCHIVE_BYTES),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const agentProfileSubagentSchema = z.object({
  description: z.string().optional(),
}).strict();

// This is intentionally narrower than kimi-code's raw profile file schema.
// OCA receives a fully compiled, immutable registry, never paths or template
// expansion inputs that could drift between creation and recovery.
const agentProfileSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  system_prompt_template: z.string().optional(),
  tools: z.array(z.string()).optional(),
	permission_policies: z.record(z.string(), z.enum(['always_allow', 'always_ask', 'always_deny'])).optional(),
  model_alias: z.string().min(1).optional(),
  thinking_effort: z.string().min(1).optional(),
  context_window: z.number().int().positive().optional(),
  when_to_use: z.string().optional(),
  subagents: z.record(z.string(), agentProfileSubagentSchema).optional(),
}).strict();

const agentProfilesSchema = z.object({
  main_profile: z.string().min(1),
  profiles: z.array(agentProfileSchema),
}).strict();

export const createSessionBodySchema = z.object({
  session_id: z.string().min(1),
  work_dir: z.string().min(1),
  system: z.string().optional(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  context_window: z.number().int().positive().optional(),
  plan_mode: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tools: z.array(toolEntrySchema).optional(),
  mcp_servers: z.array(mcpServerSchema).optional(),
  resources: z.array(resourceSchema).optional(),
  skills: z.array(skillSchema).max(MAX_SESSION_SKILLS).optional(),
	agent_profiles: agentProfilesSchema.optional(),
	session_environment_variables: z.record(z.string(), z.string()).optional(),
	vault_environment_variables: z.record(z.string(), z.string()).optional(),
}).strict();

const updateSessionConfigBodySchema = z.object({
  tools: z.array(toolEntrySchema).optional(),
	mcp_servers: z.array(mcpServerSchema).optional(),
	mcp_credentials: z.record(z.string().min(1), z.string().min(1)).optional(),
	session_environment_variables: z.record(z.string(), z.string()).optional(),
	vault_environment_variables: z.record(z.string(), z.string()).optional(),
}).strict();

const materializeSessionResourcesBodySchema = z.object({
  resources: z.array(resourceSchema).min(1),
}).strict();

const memorySyncEntrySchema = z.object({
	id: z.string().min(1),
	path: z.string().min(1),
	content: z.string(),
	content_sha256: z.string().min(1),
}).strict();

const memoryAcknowledgeBodySchema = z.object({
	resources: z.array(z.object({
		resource_id: z.string().min(1),
		memory_store_id: z.string().min(1),
		entries: z.array(memorySyncEntrySchema),
	}).strict()),
}).strict();

const sessionParamsSchema = z.object({ id: z.string().min(1) });
const sessionAgentParamsSchema = z.object({ id: z.string().min(1), agent_id: z.string().min(1) });

type CreateSessionBody = z.infer<typeof createSessionBodySchema>;
type UpdateSessionConfigBody = z.infer<typeof updateSessionConfigBodySchema>;
type MaterializeSessionResourcesBody = z.infer<typeof materializeSessionResourcesBodySchema>;
type MemoryAcknowledgeBody = z.infer<typeof memoryAcknowledgeBodySchema>;
type WireToolEntry = z.infer<typeof toolEntrySchema>;
type WireResource = z.infer<typeof resourceSchema>;
type WireAgentProfiles = z.infer<typeof agentProfilesSchema>;

export function parseCreateSessionBody(raw: unknown): CreateSessionBody {
  const result = createSessionBodySchema.safeParse(raw);
  if (!result.success) throw new FacadeError('invalid_request');
  return result.data;
}

function toToolEntry(entry: WireToolEntry): FacadeToolEntry {
  switch (entry.type) {
    case 'agent_toolset_20260401':
      return {
        type: entry.type,
        ...(entry.enabled_tools !== undefined ? { enabledTools: entry.enabled_tools } : {}),
        ...(entry.disallowed_tools !== undefined ? { disallowedTools: entry.disallowed_tools } : {}),
        ...(entry.configs !== undefined ? { configs: toToolConfigs(entry.configs) } : {}),
      };
    case 'mcp_toolset':
      return {
        type: entry.type,
        mcpServerName: entry.mcp_server_name,
        ...(entry.configs !== undefined ? { configs: toToolConfigs(entry.configs) } : {}),
      };
    case 'custom':
      return {
        type: entry.type,
        name: entry.name,
        description: entry.description,
        inputSchema: entry.input_schema,
      };
    case 'browser_toolset_20260714':
      return { type: entry.type };
  }
}

function toToolConfigs(configs: NonNullable<z.infer<typeof agentToolsetSchema>['configs']>) {
  return configs.map((config) => ({
    name: config.name,
    ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
    ...(config.permission_policy !== undefined ? { permissionPolicy: config.permission_policy } : {}),
  }));
}

function toResource(resource: WireResource): FacadeResource {
  return {
    id: resource.id,
		type: resource.type,
		...(resource.file_id !== undefined ? { fileId: resource.file_id } : {}),
		...(resource.url !== undefined ? { url: resource.url } : {}),
    ...(resource.mount_path !== undefined ? { mountPath: resource.mount_path } : {}),
    ...(resource.pvc_path !== undefined ? { pvcPath: resource.pvc_path } : {}),
		...(resource.download_url !== undefined ? { downloadUrl: resource.download_url } : {}),
		...(resource.size !== undefined ? { size: resource.size } : {}),
		...(resource.authorization_token !== undefined ? { authorizationToken: resource.authorization_token } : {}),
		...(resource.checkout !== undefined ? { checkout: resource.checkout } : {}),
		...(resource.memory_store_id !== undefined ? { memoryStoreId: resource.memory_store_id } : {}),
		...(resource.access !== undefined ? { access: resource.access } : {}),
		...(resource.instructions !== undefined ? { instructions: resource.instructions } : {}),
		...(resource.memory_entries !== undefined ? { memoryEntries: resource.memory_entries.map((entry) => ({
			id: entry.id,
			path: entry.path,
			content: entry.content,
			contentSha256: entry.content_sha256,
		})) } : {}),
  };
}

function toAgentProfiles(profiles: WireAgentProfiles): NonNullable<FacadeCreateConfig['agentProfiles']> {
  return {
    mainProfile: profiles.main_profile,
    maxAgents: 25,
    profiles: profiles.profiles.map((profile) => ({
      name: profile.name,
      ...(profile.description !== undefined ? { description: profile.description } : {}),
      ...(profile.system_prompt_template !== undefined
        ? { systemPromptTemplate: profile.system_prompt_template }
        : {}),
      ...(profile.tools !== undefined ? { tools: profile.tools } : {}),
		...(profile.permission_policies !== undefined ? { permissionPolicies: profile.permission_policies } : {}),
      ...(profile.model_alias !== undefined ? { modelAlias: profile.model_alias } : {}),
      ...(profile.thinking_effort !== undefined ? { thinkingEffort: profile.thinking_effort } : {}),
      ...(profile.context_window !== undefined ? { contextWindow: profile.context_window } : {}),
      ...(profile.when_to_use !== undefined ? { whenToUse: profile.when_to_use } : {}),
      ...(profile.subagents !== undefined ? { subagents: profile.subagents } : {}),
    })),
  };
}

/**
 * Validates the relationships in the constrained wire registry before the
 * facade allocates session state. The runtime performs the same checks when
 * it resolves its persisted registry; doing them here keeps invalid input at
 * the HTTP boundary and avoids a terminal, unusable session entry.
 */
function validateAgentProfiles(profiles: WireAgentProfiles | undefined): void {
  if (profiles === undefined) return;

  const names = new Set<string>();
  for (const profile of profiles.profiles) {
    if (names.has(profile.name)) throw new FacadeError('invalid_request');
    names.add(profile.name);
  }
  if (!names.has(profiles.main_profile)) throw new FacadeError('invalid_request');

  for (const profile of profiles.profiles) {
    for (const subagentName of Object.keys(profile.subagents ?? {})) {
      if (!names.has(subagentName)) throw new FacadeError('invalid_request');
    }
  }
}

function toCreateConfig(
  body: CreateSessionBody,
  skillArchives: FacadeCreateConfig['skillArchives'],
): FacadeCreateConfig {
  return {
    sessionId: body.session_id,
    workDir: body.work_dir,
    ...(body.system !== undefined ? { system: body.system } : {}),
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.thinking !== undefined ? { thinking: body.thinking } : {}),
    ...(body.context_window !== undefined ? { contextWindow: body.context_window } : {}),
    ...(body.plan_mode !== undefined ? { planMode: body.plan_mode } : {}),
    ...(body.metadata !== undefined
      ? { metadata: body.metadata as FacadeCreateConfig['metadata'] }
      : {}),
    ...(body.tools !== undefined ? { tools: body.tools.map(toToolEntry) } : {}),
    ...(body.mcp_servers !== undefined ? { mcpServers: body.mcp_servers } : {}),
    ...(body.resources !== undefined ? { resources: body.resources.map(toResource) } : {}),
    ...(body.skills !== undefined ? { skills: body.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      version: skill.version,
		origin: skill.origin,
      contentSize: skill.content_size,
      contentSHA256: skill.content_sha256,
    })) } : {}),
    ...(skillArchives !== undefined && skillArchives.length > 0 ? { skillArchives } : {}),
    ...(body.agent_profiles !== undefined ? { agentProfiles: toAgentProfiles(body.agent_profiles) } : {}),
	...(body.session_environment_variables !== undefined ? { sessionEnvironmentVariables: body.session_environment_variables } : {}),
	...(body.vault_environment_variables !== undefined ? { vaultEnvironmentVariables: body.vault_environment_variables } : {}),
  };
}

function toSessionConfig(body: UpdateSessionConfigBody): FacadeSessionConfig {
  return {
    ...(body.tools !== undefined ? { tools: body.tools.map(toToolEntry) } : {}),
    ...(body.mcp_servers !== undefined ? { mcpServers: body.mcp_servers } : {}),
    ...(body.mcp_credentials !== undefined ? { mcpCredentials: body.mcp_credentials } : {}),
	...(body.session_environment_variables !== undefined ? { sessionEnvironmentVariables: body.session_environment_variables } : {}),
	...(body.vault_environment_variables !== undefined ? { vaultEnvironmentVariables: body.vault_environment_variables } : {}),
  };
}

function toMemorySyncResources(body: MemoryAcknowledgeBody): FacadeMemorySyncResource[] {
	return body.resources.map((resource) => ({
		resourceId: resource.resource_id,
		memoryStoreId: resource.memory_store_id,
		entries: resource.entries.map((entry) => ({
			id: entry.id,
			path: entry.path,
			content: entry.content,
			contentSha256: entry.content_sha256,
		})),
	}));
}

export function registerSessionRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/sessions', async (request, reply) => {
    const parsed = await parseSessionCreateMultipart(request, parseCreateSessionBody);
    try {
      validateAgentProfiles(parsed.body.agent_profiles);
      const config = toCreateConfig(parsed.body, parsed.archives);
      ctx.registry.createSession(config.sessionId);
      try {
        await ctx.harness.createSession(config);
      } catch (error) {
        // The session never became usable: park it in the terminal failed
        // state so the operation x state matrix still applies to it.
        ctx.registry.markFailed(config.sessionId);
        throw error;
      }
		return await reply.code(201).send({ session_id: config.sessionId, status: 'active' });
    } finally {
      await parsed.dispose();
    }
  });

  const resumeRoute = defineRoute(
    { method: 'POST', path: '/sessions/{id}/resume', params: sessionParamsSchema },
    async (req, reply) => {
      const result = await ctx.registry.resumeSession(req.params.id);
      return reply.code(200).send({
        session_id: result.sessionId,
        status: result.status,
        pending_calls: result.pendingCalls.map((call) => ({
          tool_call_id: call.id,
          kind: call.kind,
          state: call.state,
        })),
      });
    },
  );
  app.post(resumeRoute.path, resumeRoute.options, resumeRoute.handler as RouteHandlerMethod);

  const updateConfigRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{id}/config',
      params: sessionParamsSchema,
      body: updateSessionConfigBodySchema,
    },
    async (req, reply) => {
      await ctx.harness.updateSessionConfig(req.params.id, toSessionConfig(req.body));
      return reply.code(200).send({ accepted: true });
    },
  );
  app.post(updateConfigRoute.path, updateConfigRoute.options, updateConfigRoute.handler as RouteHandlerMethod);

  const materializeResourcesRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{id}/resources',
      params: sessionParamsSchema,
      body: materializeSessionResourcesBodySchema,
    },
    async (req, reply) => {
      await ctx.harness.materializeSessionResources(
        req.params.id,
        (req.body as MaterializeSessionResourcesBody).resources.map(toResource),
      );
      return reply.code(200).send({ accepted: true });
    },
  );
	app.post(
    materializeResourcesRoute.path,
    materializeResourcesRoute.options,
    materializeResourcesRoute.handler as RouteHandlerMethod,
	);

	const memorySnapshotRoute = defineRoute(
		{ method: 'GET', path: '/sessions/{id}/memory-snapshot', params: sessionParamsSchema },
		async (req, reply) => {
			const resources = await ctx.harness.snapshotSessionMemory(req.params.id);
			return reply.code(200).send({
				resources: resources.map((resource) => ({
					resource_id: resource.resourceId,
					memory_store_id: resource.memoryStoreId,
					entries: resource.entries.map((entry) => ({
						id: entry.id,
						path: entry.path,
						content_sha256: entry.contentSha256,
						deleted: entry.deleted,
						...(entry.content === undefined ? {} : { content: entry.content }),
					})),
				})),
			});
		},
	);
	app.get(memorySnapshotRoute.path, memorySnapshotRoute.options, memorySnapshotRoute.handler as RouteHandlerMethod);

	const memoryAcknowledgeRoute = defineRoute(
		{
			method: 'POST',
			path: '/sessions/{id}/memory-acknowledgement',
			params: sessionParamsSchema,
			body: memoryAcknowledgeBodySchema,
		},
		async (req, reply) => {
			await ctx.harness.acknowledgeSessionMemory(req.params.id, toMemorySyncResources(req.body as MemoryAcknowledgeBody));
			return reply.code(200).send({ accepted: true });
		},
	);
	app.post(memoryAcknowledgeRoute.path, memoryAcknowledgeRoute.options, memoryAcknowledgeRoute.handler as RouteHandlerMethod);

  // This is an internal runtime-control route. The public Qoder Thread id is
  // never exposed here; the orchestrator resolves it to the runtime child id
  // inside its ordered input command.
  const archiveAgentRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{id}/agents/{agent_id}/archive',
      params: sessionAgentParamsSchema,
    },
    async (req, reply) => {
      await ctx.harness.removeAgent(req.params.id, req.params.agent_id);
      return reply.code(200).send({ accepted: true });
    },
  );
  app.post(
    archiveAgentRoute.path,
    archiveAgentRoute.options,
    archiveAgentRoute.handler as RouteHandlerMethod,
  );

  const interruptAgentRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{id}/agents/{agent_id}/interrupt',
      params: sessionAgentParamsSchema,
    },
    async (req, reply) => {
      await ctx.harness.interruptAgent(req.params.id, req.params.agent_id);
      return reply.code(202).send({ accepted: true });
    },
  );
  app.post(
    interruptAgentRoute.path,
    interruptAgentRoute.options,
    interruptAgentRoute.handler as RouteHandlerMethod,
  );

  const interruptRoute = defineRoute(
    { method: 'POST', path: '/sessions/{id}/interrupt', params: sessionParamsSchema },
    async (req, reply) => {
      ctx.registry.interrupt(req.params.id);
      await ctx.harness.interrupt(req.params.id);
      return reply.code(202).send({ accepted: true });
    },
  );
  app.post(
    interruptRoute.path,
    interruptRoute.options,
    interruptRoute.handler as RouteHandlerMethod,
  );

  const cancelRoute = defineRoute(
    { method: 'POST', path: '/sessions/{id}/cancel', params: sessionParamsSchema },
    async (req, reply) => {
      const sessionId = req.params.id;
      ctx.registry.cancelSession(sessionId);
      // End the in-flight inline channel, if any, with the cancelled terminal
      // frame (the registry already recorded the idempotency outcome).
      ctx.pump.endTurn(sessionId, { type: 'prompt_done', stop_reason: 'cancelled' });
      try {
        await ctx.harness.cancelSession(sessionId);
      } catch (error) {
        // Cancel is terminal cleanup: a session the harness no longer holds
        // is already as cancelled as it gets.
        if (!isFacadeError(error) || error.code !== 'session_not_found') throw error;
      }
      ctx.pump.dropSession(sessionId);
      return reply.code(202).send({ accepted: true });
    },
  );
  app.post(cancelRoute.path, cancelRoute.options, cancelRoute.handler as RouteHandlerMethod);
}
