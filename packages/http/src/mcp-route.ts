import {
  CLIENT_INFO_META_KEY,
  Server,
  createMcpHandler,
  type AuthInfo,
  type Tool,
} from '@modelcontextprotocol/server'
import type {
  Caller,
  RequestAuth,
  RequestContext,
  ResponseEnvelope,
  ToolDefinition,
  ToolResult,
  ToolSurface,
} from '@nymbalhq/types'
import type { HttpServer } from './server.js'

export const MCP_PATH = '/api/mcp'

export interface MountMcpDeps {
  /** The app `attachHttp` ran on: its tool surface. */
  app: { readonly mcp: ToolSurface | undefined }
  /** Verifies a bearer the store signed; rejects one it did not. */
  verify: (token: string) => Promise<{ sub: string; roles?: readonly string[] }>
  /** The origins CORS allows: a request from any other is refused. */
  origins: readonly string[]
  enabled: boolean
  version?: string
}

export interface ToolEndpointDeps {
  path: string
  surface: ToolSurface
  verify: MountMcpDeps['verify']
  origins: readonly string[]
  /**
   * Whether each call is also held to its tool's route's rate rule. A tool that is a route says yes; a tool that is
   * not (a UCP tool) counts once, against the endpoint's rule.
   */
  admitTools: boolean
  version?: string
}

/** What one HTTP request hands the per-request MCP server: who calls, and the rate rule of each tool's route. */
interface RequestState {
  auth: RequestAuth | undefined
  ip: string
  admit: (tool: ToolDefinition) => ToolResult | null
}

function refuse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): ResponseEnvelope {
  return { status, headers, body: { error: { code, message } } }
}

function textResult(structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: true,
  }
}

function bearerOf(ctx: RequestContext): string | undefined {
  const raw = ctx.headers.authorization
  const header = Array.isArray(raw) ? raw[0] : raw
  if (header === undefined || !header.toLowerCase().startsWith('bearer ')) return undefined
  return header.slice('bearer '.length).trim()
}

/** The SDK lifts the client's `_meta` clientInfo into the request's envelope before a handler sees it. */
function agentOf(envelope: object | undefined, server: Server): Caller['agent'] {
  const meta = envelope as Record<string, unknown> | undefined
  const info = (meta?.[CLIENT_INFO_META_KEY] ?? server.getClientVersion()) as
    | { name?: unknown; version?: unknown }
    | undefined
  return {
    name: typeof info?.name === 'string' ? info.name : 'mcp-client',
    ...(typeof info?.version === 'string' && { version: info.version }),
  }
}

function toolServer(surface: ToolSurface, state: RequestState, version: string): Server {
  const server = new Server({ name: 'nymbal', version }, { capabilities: { tools: {} } })
  const caller = (agent: Caller['agent']): Caller => ({
    ...(state.auth !== undefined && { auth: state.auth }),
    agent,
    ip: state.ip,
  })
  server.setRequestHandler('tools/list', (_request, ctx) => ({
    tools: surface.list(caller(agentOf(ctx.mcpReq.envelope, server))).map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      // Converted from the route's Zod schema, so every keyword's value is JSON.
      inputSchema: tool.inputSchema as Tool['inputSchema'],
      annotations: { readOnlyHint: tool.kind === 'read' },
    })),
  }))
  server.setRequestHandler('tools/call', async (request, ctx) => {
    const who = caller(agentOf(ctx.mcpReq.envelope, server))
    const tool = surface.list(who).find((listed) => listed.name === request.params.name)
    const result =
      (tool && state.admit(tool)) ??
      (await surface.call(request.params.name, request.params.arguments ?? {}, who))
    return server.projectCallToolResult({ ...result }, undefined)
  })
  return server
}

/**
 * An MCP endpoint over Streamable HTTP at `deps.path`, serving a tool surface. It reads no cookie, so it takes no CSRF
 * token; in its place an `Origin` other than the store's own is refused, a bearer that does not verify is refused, and
 * the endpoint (and, under `admitTools`, each tool's route) is held to its rate rule.
 */
export async function mountToolEndpoint(server: HttpServer, deps: ToolEndpointDeps): Promise<void> {
  const { surface } = deps
  const adapter = server.adapter
  // The SDK hands a request's server factory only what `fetch` was given as `authInfo`, so the verified caller and
  // the request's rate admission ride there; the bearer itself does not.
  const handler = createMcpHandler(({ authInfo }) => {
    const state = authInfo?.extra?.['nymbal'] as RequestState
    return toolServer(surface, state, deps.version ?? '0.0.0')
  })
  const origins = new Set(deps.origins)

  const serve = async (ctx: RequestContext): Promise<Response | ResponseEnvelope> => {
    const origin = ctx.headers.origin
    if (typeof origin === 'string' && !origins.has(origin)) {
      return refuse(
        403,
        'origin.forbidden',
        `Origin ${origin} may not call this store's agent endpoint`,
      )
    }
    const token = bearerOf(ctx)
    let auth: RequestAuth | undefined
    if (token !== undefined) {
      try {
        const payload = await deps.verify(token)
        auth = { userId: payload.sub, roles: [...(payload.roles ?? [])] }
      } catch {
        return refuse(401, 'auth.unauthorized', 'The bearer token does not verify', {
          'www-authenticate': 'Bearer error="invalid_token"',
        })
      }
    }
    const state: RequestState = {
      auth,
      ip: ctx.ip,
      admit(tool) {
        if (!deps.admitTools) return null
        const refused = adapter.guard.admit(
          {
            ...ctx,
            method: tool.route.method,
            path: tool.route.path,
            headers: {},
            body: undefined,
          },
          { csrf: false },
        )
        if (refused === null) return null
        const error = (refused.body as { error?: { retryAfter?: number } } | undefined)?.error
        return textResult({
          code: 'rate.limited',
          message: `Too many ${tool.name} calls`,
          ...(error?.retryAfter !== undefined && { retryAfter: error.retryAfter }),
        })
      },
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(ctx.headers)) {
      if (value === undefined || name === 'authorization' || name === 'cookie') continue
      for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
    }
    const host = typeof ctx.headers.host === 'string' ? ctx.headers.host : 'localhost'
    const request = new Request(new URL(ctx.url, `http://${host}`), { method: ctx.method, headers })
    const authInfo: AuthInfo = {
      token: '',
      clientId: auth?.userId ?? 'anonymous',
      scopes: auth?.roles ?? [],
      extra: { nymbal: state },
    }
    return handler.fetch(request, {
      authInfo,
      ...(ctx.method === 'POST' && { parsedBody: ctx.body }),
    })
  }

  for (const method of ['POST', 'GET', 'DELETE'] as const) {
    adapter.registerWebRoute(method, deps.path, serve, { csrf: false })
  }
}

/**
 * `POST /api/mcp`: the app's routes as tools, each call held to its route's rate rule as well as the endpoint's.
 * Mounted after `attachHttp`, beside the routes it registered.
 */
export async function mountMcp(server: HttpServer, deps: MountMcpDeps): Promise<void> {
  if (!deps.enabled) return
  const surface = deps.app.mcp
  if (surface === undefined) {
    throw new Error('mountMcp needs the tool surface attachHttp builds: call attachHttp first')
  }
  await mountToolEndpoint(server, {
    path: MCP_PATH,
    surface,
    verify: deps.verify,
    origins: deps.origins,
    admitTools: true,
    ...(deps.version !== undefined && { version: deps.version }),
  })
}
