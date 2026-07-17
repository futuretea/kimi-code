import type { FastifyInstance, RouteHandlerMethod } from 'fastify';
import { z } from 'zod';

import { isFacadeError } from '../errors';
import type { FacadeCreateConfig, FacadeResource, FacadeToolEntry } from '../facade-types';

import type { RouteContext } from './context';
import { defineRoute } from './define-route';

/**
 * Session lifecycle routes: create / resume / interrupt / cancel. The wire
 * schema is snake_case (contract); it is mapped onto the camelCase internal
 * config types at the boundary.
 */

const toolsetSchema = z.object({
  type: z.string().min(1),
  enabled_tools: z.array(z.string()).optional(),
  permission_policy: z.string().optional(),
});

const externalToolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
});

const mcpServerSchema = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  url: z.string().min(1),
});

const resourceSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  file_id: z.string().optional(),
  path: z.string().optional(),
  url: z.string().optional(),
  mount_path: z.string().optional(),
});

const memoryEntrySchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const skillSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  version: z.number().optional(),
});

const createSessionBodySchema = z.object({
  session_id: z.string().min(1),
  work_dir: z.string().min(1),
  system: z.string().optional(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  permission_policy: z.enum(['always_allow', 'always_ask', 'always_deny']).optional(),
  plan_mode: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  tools: z.array(z.union([toolsetSchema, externalToolSchema])).optional(),
  mcp_servers: z.array(mcpServerSchema).optional(),
  resources: z.array(resourceSchema).optional(),
  memory_store_entries: z.array(memoryEntrySchema).optional(),
  skills: z.array(skillSchema).optional(),
});

const sessionParamsSchema = z.object({ id: z.string().min(1) });

type CreateSessionBody = z.infer<typeof createSessionBodySchema>;
type WireToolEntry = z.infer<typeof toolsetSchema> | z.infer<typeof externalToolSchema>;
type WireResource = z.infer<typeof resourceSchema>;

function toToolEntry(entry: WireToolEntry): FacadeToolEntry {
  if ('name' in entry) {
    return { name: entry.name, description: entry.description, parameters: entry.parameters };
  }
  return {
    type: entry.type,
    ...(entry.enabled_tools !== undefined ? { enabledTools: entry.enabled_tools } : {}),
    ...(entry.permission_policy !== undefined ? { permissionPolicy: entry.permission_policy } : {}),
  };
}

function toResource(resource: WireResource): FacadeResource {
  return {
    id: resource.id,
    type: resource.type,
    ...(resource.file_id !== undefined ? { fileId: resource.file_id } : {}),
    ...(resource.path !== undefined ? { path: resource.path } : {}),
    ...(resource.url !== undefined ? { url: resource.url } : {}),
    ...(resource.mount_path !== undefined ? { mountPath: resource.mount_path } : {}),
  };
}

function toCreateConfig(body: CreateSessionBody): FacadeCreateConfig {
  return {
    sessionId: body.session_id,
    workDir: body.work_dir,
    ...(body.system !== undefined ? { system: body.system } : {}),
    ...(body.model !== undefined ? { model: body.model } : {}),
    ...(body.thinking !== undefined ? { thinking: body.thinking } : {}),
    ...(body.permission_policy !== undefined ? { permissionPolicy: body.permission_policy } : {}),
    ...(body.plan_mode !== undefined ? { planMode: body.plan_mode } : {}),
    ...(body.metadata !== undefined
      ? { metadata: body.metadata as FacadeCreateConfig['metadata'] }
      : {}),
    ...(body.tools !== undefined ? { tools: body.tools.map(toToolEntry) } : {}),
    ...(body.mcp_servers !== undefined ? { mcpServers: body.mcp_servers } : {}),
    ...(body.resources !== undefined ? { resources: body.resources.map(toResource) } : {}),
    ...(body.memory_store_entries !== undefined
      ? { memoryStoreEntries: body.memory_store_entries }
      : {}),
    ...(body.skills !== undefined ? { skills: body.skills } : {}),
  };
}

export function registerSessionRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const createRoute = defineRoute(
    { method: 'POST', path: '/sessions', body: createSessionBodySchema },
    async (req, reply) => {
      const config = toCreateConfig(req.body);
      ctx.registry.createSession(config.sessionId);
      try {
        await ctx.harness.createSession(config);
      } catch (error) {
        // The session never became usable: park it in the terminal failed
        // state so the operation x state matrix still applies to it.
        ctx.registry.markFailed(config.sessionId);
        throw error;
      }
      return reply.code(201).send({ session_id: config.sessionId, status: 'active' });
    },
  );
  app.post(createRoute.path, createRoute.options, createRoute.handler as RouteHandlerMethod);

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
