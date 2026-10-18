import {
  ConfigError,
  type HttpAdapter,
  type HttpMethod,
  type RequestContext,
  type ResponseEnvelope,
} from '@nymbalhq/types'
import { fail } from './envelope.js'
import { routeSchemas, type RouteSchema } from './schemas.js'

interface Issue {
  path: Array<string | number>
  message: string
}

type Parsed = { ok: true; ctx: RequestContext } | { ok: false; issues: Issue[] }

const PARTS = ['params', 'query', 'body'] as const

function schemaFor(method: HttpMethod, path: string): RouteSchema {
  const key = `${method} ${path}`
  const schema = routeSchemas[key]
  if (!schema) {
    throw new ConfigError(`route ${key} has no entry in routeSchemas`, {
      code: 'config.route_schema_missing',
      context: { method, path },
    })
  }
  return schema
}

/** The context the handler sees: each part parsed by its schema, an undeclared part empty. */
function parseInput(schema: RouteSchema, ctx: RequestContext): Parsed {
  const issues: Issue[] = []
  const parsed: { params: unknown; query: unknown; body: unknown } = {
    params: {},
    query: {},
    body: undefined,
  }
  for (const part of PARTS) {
    const partSchema = schema[part]
    if (!partSchema) continue
    const result = partSchema.safeParse(ctx[part])
    if (result.success) parsed[part] = result.data
    else {
      for (const issue of result.error.issues) {
        issues.push({ path: [part, ...issue.path], message: issue.message })
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues }
  return {
    ok: true,
    ctx: {
      ...ctx,
      params: parsed.params as RequestContext['params'],
      query: parsed.query as RequestContext['query'],
      body: parsed.body,
    },
  }
}

function invalid(issues: Issue[]): ResponseEnvelope {
  return fail('validation.failed', 'The request input is invalid', 400, { issues })
}

/**
 * The adapter `registerAllRoutes` registers through: a route with no entry in `routeSchemas` stops startup, and
 * every request's params, query and body are parsed after the adapter's guard and middlewares, before the handler.
 */
export function validatedAdapter(adapter: HttpAdapter): HttpAdapter {
  return {
    registerRoute(method, path, handler, options) {
      const schema = schemaFor(method, path)
      adapter.registerRoute(
        method,
        path,
        async (ctx) => {
          const input = parseInput(schema, ctx)
          return input.ok ? handler(input.ctx) : invalid(input.issues)
        },
        options,
      )
    },
    registerStreamRoute(method, path, handler, options) {
      const schema = schemaFor(method, path)
      adapter.registerStreamRoute(
        method,
        path,
        async (ctx, stream) => {
          const input = parseInput(schema, ctx)
          if (input.ok) return handler(input.ctx, stream)
          stream.send({ event: 'error', data: { code: 'validation.failed', issues: input.issues } })
          stream.close()
        },
        options,
      )
    },
    registerMiddleware(middleware) {
      adapter.registerMiddleware(middleware)
    },
    setDefaultHeaders(headers) {
      adapter.setDefaultHeaders(headers)
    },
    start(port, host) {
      return adapter.start(port, host)
    },
    stop() {
      return adapter.stop()
    },
  }
}
