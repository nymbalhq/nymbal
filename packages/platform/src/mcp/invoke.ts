import { v7 as uuidv7 } from 'uuid'
import {
  IDEMPOTENCY_KEY_HEADER,
  isValidIdempotencyKey,
  NymbalError,
  type Caller,
  type Logger,
  type RequestAuth,
  type RequestContext,
  type ResponseEnvelope,
  type ToolDefinition,
  type ToolResult,
  type ToolSurface,
} from '@nymbalhq/types'
import type { ProposalRecord } from '../repositories/proposal.js'
import type { ProposalService } from '../services/proposal-service.js'
import { fail, renderError } from '../routes/envelope.js'
import { routeSchemas, type RouteSchema } from '../routes/schemas.js'
import { invalid, parseInput } from '../routes/validated-adapter.js'
import { scrubDeep } from '../settings/secret-set.js'
import { ProposalError, type Executed, type Policy } from './proposals.js'
import { PARTS, partShape } from './registry.js'
import type { RecordedRoute, RouteTable } from './route-table.js'

export type { Caller, ToolResult } from '@nymbalhq/types'

export interface InvokerDeps {
  table: RouteTable
  tools: ToolDefinition[]
  proposals: Pick<ProposalService, 'propose' | 'run'>
  policy: Policy
  logger: Logger
}

/** The tool surface, and how a stored proposal is run through its route (for the proposal service, not for agents). */
export interface Invoker extends ToolSurface {
  execute(row: ProposalRecord, auth: RequestAuth | undefined): Promise<Executed>
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

/** The status a route answered, and its error's code and message when it refused. */
function outcomeOf(envelope: ResponseEnvelope): Executed['outcome'] {
  if (envelope.status < 400) return { status: envelope.status }
  const body = isRecord(envelope.body) ? envelope.body : {}
  const error = isRecord(body['error']) ? body['error'] : {}
  return {
    status: envelope.status,
    ...(typeof error['code'] === 'string' && { code: error['code'] }),
    ...(typeof error['message'] === 'string' && { message: error['message'] }),
  }
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

/** The arguments a proposal keeps, apart from the handles' values; the idempotency key is kept on its own. */
function storedArgs(entry: RouteSchema, args: Record<string, unknown>) {
  const kept: Record<string, unknown> = {}
  const handles: Record<string, string> = {}
  for (const [key, value] of Object.entries(args)) {
    if (key === 'idempotencyKey') continue
    if (!Object.hasOwn(entry.handles ?? {}, key)) kept[key] = value
    else if (typeof value === 'string' && value !== '') handles[key] = value
  }
  return { args: kept, ...(Object.keys(handles).length > 0 && { handles }) }
}

/**
 * Runs agent tools as the routes they are: each call is a request built from the arguments and handed to the
 * composed handler the HTTP adapter runs, so the gate, the schema, correlation, audit and idempotency hold for it as
 * for a request over HTTP. A command tool stops after the gate and the schema and becomes a proposal: an admin's is
 * kept for an admin to decide, a shopper's only when a policy approves it, and one a policy approves runs at once.
 */
export function createInvoker(deps: InvokerDeps): Invoker {
  const { table, tools, proposals, policy, logger } = deps
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  function contextOf(
    tool: ToolDefinition,
    entry: RouteSchema,
    args: Record<string, unknown>,
    caller: Caller,
    correlationId?: string,
  ) {
    const { params, query, body } = splitArgs(entry, args)
    const requestId = uuidv7()
    const correlation = correlationId ?? requestId
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
      correlationId: correlation,
      logger: logger.child({ requestId, correlationId: correlation, tool: tool.name }),
      ip: caller.ip ?? '127.0.0.1',
      agent: { name: caller.agent.name },
    }
    return ctx
  }

  function lookup(name: string) {
    // A tool listed for nobody is called by nobody: every tool that runs went through its route's admit.
    const tool = UNLISTED.has(name) ? undefined : byName.get(name)
    const key = tool && `${tool.route.method} ${tool.route.path}`
    const entry = key && routeSchemas[key]
    const route = key && table.get(key)
    return tool && entry && route ? { tool, entry, route } : undefined
  }

  async function run(route: RecordedRoute, ctx: RequestContext) {
    try {
      return await route.handler(ctx)
    } catch (err) {
      if (err instanceof NymbalError) return renderError(err)
      ctx.logger.error({ err }, 'tool handler threw')
      return fail('internal', 'Internal server error', 500)
    }
  }

  async function propose(
    tool: ToolDefinition,
    entry: RouteSchema,
    route: RecordedRoute,
    args: Record<string, unknown>,
    ctx: RequestContext,
    caller: Caller,
    proposeWrites: boolean,
  ): Promise<ToolResult> {
    const refused = route.gate?.(ctx)
    if (refused) return resultOfEnvelope(refused, entry)
    const parsed = parseInput(entry, ctx)
    if (!parsed.ok) return resultOfEnvelope(invalid(parsed.issues), entry)
    const command = tool.route.command as string
    const admin = tool.scope === 'admin'
    // Only an admin write keeps a key (register.ts): a shopper's route drops it, and so does its proposal.
    const key = admin ? args['idempotencyKey'] : undefined
    if (key !== undefined && !(typeof key === 'string' && isValidIdempotencyKey(key))) {
      return refusal(
        'validation.failed',
        'idempotencyKey must be 1-128 characters of A-Z, a-z, 0-9, ".", "_", ":" and "-"',
      )
    }
    const decider = proposeWrites ? null : policy(command)
    if (!admin && decider === null) {
      ctx.logger.info(
        { command, userId: caller.auth?.userId, agent: caller.agent },
        'agent proposal not kept: no policy approves it',
      )
      return resultOf({ status: 'proposed', id: null, tool: tool.name, command }, false)
    }
    const view = await proposals.propose({
      tool: tool.name,
      command,
      ...storedArgs(entry, args),
      ...(key !== undefined && { idempotencyKey: key }),
      caller,
      correlationId: ctx.correlationId,
      at: new Date().toISOString(),
    })
    if (decider === null) {
      return resultOf({ status: 'proposed', id: view.id, tool: tool.name, command }, false)
    }
    try {
      return (await proposals.run(view.id, decider, caller.auth)).result
    } catch (err) {
      if (!(err instanceof ProposalError)) throw err
      // The key's proposal was decided by an earlier call: once approved, the same request with the same key is
      // the route's own replay; a rejected or failed one runs nothing again.
      const status = err.context['status']
      if (status === 'approved' || status === 'applied') {
        return resultOfEnvelope(await run(route, ctx), entry)
      }
      return resultOf({ ...err.context, code: err.code, message: err.message }, true)
    }
  }

  return {
    list(caller) {
      const level = levelOf(caller)
      return tools.filter((tool) => RANK[tool.scope] <= level && !UNLISTED.has(tool.name))
    },

    async call(name, args, caller, options = {}) {
      const found = lookup(name)
      if (found === undefined) return refusal('tool.unknown', `No tool is named ${name}`)
      if (args !== undefined && args !== null && !isRecord(args)) {
        return refusal('validation.failed', 'A tool takes its arguments as one object')
      }
      const { tool, entry, route } = found
      const ctx = contextOf(tool, entry, args ?? {}, caller, options.correlationId)
      if (tool.kind === 'command') {
        return propose(tool, entry, route, args ?? {}, ctx, caller, options.proposeWrites === true)
      }
      return resultOfEnvelope(await run(route, ctx), entry)
    },

    async execute(row, auth) {
      const found = lookup(row.tool)
      if (found === undefined) {
        return {
          result: refusal('tool.unknown', `No tool is named ${row.tool}`),
          outcome: { status: 404, code: 'tool.unknown', message: `No tool is named ${row.tool}` },
        }
      }
      const { tool, entry, route } = found
      const caller: Caller = {
        ...(auth !== undefined && { auth }),
        agent: {
          name: row.agentName,
          ...(row.agentVersion !== null && { version: row.agentVersion }),
        },
      }
      const args = {
        ...row.args,
        ...row.handles,
        idempotencyKey: row.idempotencyKey ?? `proposal:${row.id}`,
      }
      const envelope = await run(route, contextOf(tool, entry, args, caller, row.correlationId))
      return { result: resultOfEnvelope(envelope, entry), outcome: outcomeOf(envelope) }
    },
  }
}
