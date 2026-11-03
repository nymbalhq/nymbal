import { v7 as uuidv7 } from 'uuid'
import {
  IDEMPOTENCY_KEY_HEADER,
  NymbalError,
  type Caller,
  type Logger,
  type RequestContext,
  type ResponseEnvelope,
  type ToolDefinition,
  type ToolResult,
  type ToolSurface,
} from '@nymbalhq/types'
import { fail, renderError } from '../routes/envelope.js'
import { routeSchemas, type RouteSchema } from '../routes/schemas.js'
import { invalid, parseInput } from '../routes/validated-adapter.js'
import { scrubDeep } from '../settings/secret-set.js'
import type { ProposalSink } from './proposals.js'
import { PARTS, partShape } from './registry.js'
import type { RouteTable } from './route-table.js'

export type { Caller, ToolResult } from '@nymbalhq/types'

export interface InvokerDeps {
  table: RouteTable
  tools: ToolDefinition[]
  writes: 'proposal' | 'apply'
  sink: ProposalSink
  logger: Logger
}

const RANK = { public: 0, customer: 1, admin: 2 } as const

/** A guest reads its own order by an order key no tool argument carries yet, so the tool is listed for nobody. */
const UNLISTED = new Set(['orders_get'])

function levelOf(caller: Caller): number {
  if (!caller.auth?.userId) return RANK.public
  return caller.auth.roles?.includes('admin') === true ? RANK.admin : RANK.customer
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resultOf(structured: Record<string, unknown>, isError: boolean): ToolResult {
  const clean = scrubDeep(structured)
  return {
    content: [{ type: 'text', text: JSON.stringify(clean) }],
    structuredContent: clean,
    ...(isError && { isError: true }),
  }
}

function refusal(code: string, message: string): ToolResult {
  return resultOf({ code, message }, true)
}

/** MCP wants an object: an array answers `{ items }`, a bare value `{ value }`, nothing `{}`. */
function structuredOf(data: unknown): Record<string, unknown> {
  if (data === undefined) return {}
  if (Array.isArray(data)) return { items: data }
  return isRecord(data) ? { ...data } : { value: data }
}

function resultOfEnvelope(envelope: ResponseEnvelope, entry: RouteSchema): ToolResult {
  const body = isRecord(envelope.body) ? envelope.body : {}
  if (envelope.status >= 400) {
    const error = isRecord(body['error']) ? body['error'] : {}
    const context = isRecord(error['context']) ? error['context'] : {}
    return resultOf(
      {
        ...context,
        code: typeof error['code'] === 'string' ? error['code'] : `http.${envelope.status}`,
        message: typeof error['message'] === 'string' ? error['message'] : 'The route refused',
      },
      true,
    )
  }
  const structured = structuredOf(body['data'])
  for (const [argument, cookieName] of Object.entries(entry.handles ?? {})) {
    const set = envelope.cookies?.find((cookie) => cookie.name === cookieName)
    if (set !== undefined && set.value !== '') structured[`${argument}Handle`] = set.value
  }
  return resultOf(structured, false)
}

/**
 * The keys each part of a route declares, so a flat argument object can be split back into params, query and body.
 * A key no part declares goes where an HTTP client would have sent it (the body, or the query of a route without
 * one), so the route's own schema refuses or strips it as it does over HTTP.
 */
function splitArgs(
  entry: RouteSchema,
  args: Record<string, unknown>,
): Pick<RequestContext, 'params' | 'query' | 'body'> {
  const parts: Record<(typeof PARTS)[number], Record<string, unknown>> = {
    params: {},
    query: {},
    body: {},
  }
  const owner = new Map<string, (typeof PARTS)[number]>()
  for (const part of PARTS) {
    for (const key of Object.keys(partShape(entry[part]).object?.shape ?? {})) owner.set(key, part)
  }
  const transport = new Set([...Object.keys(entry.handles ?? {}), 'idempotencyKey'])
  const undeclared = entry.body === undefined ? 'query' : 'body'
  for (const [key, value] of Object.entries(args)) {
    const part = owner.get(key) ?? (transport.has(key) ? undefined : undeclared)
    if (part !== undefined) parts[part][key] = value
  }
  const { object, optional } = partShape(entry.body)
  const hasBody = Object.keys(parts.body).length > 0 || (object !== undefined && !optional)
  return {
    params: parts.params as RequestContext['params'],
    query: parts.query as RequestContext['query'],
    body: hasBody ? parts.body : undefined,
  }
}

function urlOf(path: string, params: Record<string, unknown>, query: Record<string, unknown>) {
  const filled = path.replace(/:([A-Za-z0-9_]+)/g, (whole, name: string) =>
    typeof params[name] === 'string' ? encodeURIComponent(params[name]) : whole,
  )
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      if (typeof one === 'string') search.append(key, one)
    }
  }
  const qs = search.toString()
  return qs === '' ? filled : `${filled}?${qs}`
}

/**
 * Runs agent tools as the routes they are: each call is a request built from the arguments and handed to the
 * composed handler the HTTP adapter runs, so the gate, the schema, correlation, audit and idempotency hold for it as
 * for a request over HTTP. Under `writes: 'proposal'` a command tool stops after the gate and the schema and hands its
 * input to the sink.
 */
export function createInvoker(deps: InvokerDeps): ToolSurface {
  const { table, tools, writes, sink, logger } = deps
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  function contextOf(
    tool: ToolDefinition,
    entry: RouteSchema,
    args: Record<string, unknown>,
    caller: Caller,
  ) {
    const { params, query, body } = splitArgs(entry, args)
    const requestId = uuidv7()
    const agent =
      caller.agent.version === undefined
        ? caller.agent.name
        : `${caller.agent.name}/${caller.agent.version}`
    const headers: RequestContext['headers'] = {
      'user-agent': agent,
      'x-nymbal-agent': caller.agent.name,
    }
    const cookies: Record<string, string> = {}
    for (const [argument, cookieName] of Object.entries(entry.handles ?? {})) {
      const handle = args[argument]
      if (typeof handle === 'string' && handle !== '') cookies[cookieName] = handle
    }
    const key = args['idempotencyKey']
    if (typeof key === 'string') headers[IDEMPOTENCY_KEY_HEADER] = key
    const ctx: RequestContext = {
      method: tool.route.method,
      path: tool.route.path,
      url: urlOf(tool.route.path, params, query),
      params,
      query,
      body,
      headers,
      cookies,
      // The bearer itself stays with the transport: a route that echoes its context cannot hand it back.
      ...(caller.auth !== undefined && {
        auth: {
          ...(caller.auth.userId !== undefined && { userId: caller.auth.userId }),
          ...(caller.auth.roles !== undefined && { roles: caller.auth.roles }),
        },
      }),
      requestId,
      correlationId: requestId,
      logger: logger.child({ requestId, correlationId: requestId, tool: tool.name }),
      ip: caller.ip ?? '127.0.0.1',
    }
    return ctx
  }

  async function propose(
    tool: ToolDefinition,
    entry: RouteSchema,
    ctx: RequestContext,
    caller: Caller,
  ) {
    const refused = table.get(`${tool.route.method} ${tool.route.path}`)?.gate?.(ctx)
    if (refused) return resultOfEnvelope(refused, entry)
    const parsed = parseInput(entry, ctx)
    if (!parsed.ok) return resultOfEnvelope(invalid(parsed.issues), entry)
    const input: Record<string, unknown> = {
      ...(parsed.ctx.params as Record<string, unknown>),
      ...(parsed.ctx.query as Record<string, unknown>),
      ...(isRecord(parsed.ctx.body) ? parsed.ctx.body : {}),
    }
    const command = tool.route.command as string
    const { id } = await sink.propose({
      tool: tool.name,
      command,
      input,
      caller,
      correlationId: ctx.correlationId,
      at: new Date().toISOString(),
    })
    return resultOf({ status: 'proposed', id, tool: tool.name, command, input }, false)
  }

  return {
    list(caller) {
      const level = levelOf(caller)
      return tools.filter((tool) => RANK[tool.scope] <= level && !UNLISTED.has(tool.name))
    },

    async call(name, args, caller) {
      const tool = byName.get(name)
      const entry = tool && routeSchemas[`${tool.route.method} ${tool.route.path}`]
      const route = tool && table.get(`${tool.route.method} ${tool.route.path}`)
      if (tool === undefined || entry === undefined || route === undefined) {
        return refusal('tool.unknown', `No tool is named ${name}`)
      }
      if (args !== undefined && args !== null && !isRecord(args)) {
        return refusal('validation.failed', 'A tool takes its arguments as one object')
      }
      const ctx = contextOf(tool, entry, args ?? {}, caller)
      if (tool.kind === 'command' && writes === 'proposal') return propose(tool, entry, ctx, caller)
      let envelope: ResponseEnvelope
      try {
        envelope = await route.handler(ctx)
      } catch (err) {
        if (err instanceof NymbalError) envelope = renderError(err)
        else {
          ctx.logger.error({ err }, 'tool handler threw')
          envelope = fail('internal', 'Internal server error', 500)
        }
      }
      return resultOfEnvelope(envelope, entry)
    },
  }
}
