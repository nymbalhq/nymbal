import type { HttpAdapter, RouteHandler, ToolDefinition } from '@nymbalhq/types'
import { gateOf, type Gate } from '../routes/role-middleware.js'

export type Scope = ToolDefinition['scope']

export interface RecordedRoute {
  /** The handler as the HTTP adapter runs it: gate, schema, correlation, audit and idempotency composed. */
  handler: RouteHandler
  gate: Gate | undefined
  scope: Scope
}

function scopeOf(gate: Gate | undefined): Scope {
  if (gate?.scope === undefined) return 'public'
  return gate.scope === 'admin' ? 'admin' : 'customer'
}

/** Every route `registerAllRoutes` registered, by `"<METHOD> <path>"`; stream routes are not tools and not kept. */
export class RouteTable {
  readonly #routes = new Map<string, RecordedRoute>()

  record(key: string, handler: RouteHandler): void {
    const gate = gateOf(handler)
    this.#routes.set(key, { handler, gate, scope: scopeOf(gate) })
  }

  get(key: string): RecordedRoute | undefined {
    return this.#routes.get(key)
  }

  keys(): string[] {
    return [...this.#routes.keys()]
  }
}

/** The innermost adapter of the route chain: it keeps each composed handler in `table`, then registers it. */
export function recordingAdapter(table: RouteTable, adapter: HttpAdapter): HttpAdapter {
  return {
    registerRoute(method, path, handler, options) {
      table.record(`${method} ${path}`, handler)
      adapter.registerRoute(method, path, handler, options)
    },
    registerStreamRoute: (method, path, handler, options) =>
      adapter.registerStreamRoute(method, path, handler, options),
    registerMiddleware: (middleware) => adapter.registerMiddleware(middleware),
    setDefaultHeaders: (headers) => adapter.setDefaultHeaders(headers),
    start: (port, host) => adapter.start(port, host),
    stop: () => adapter.stop(),
  }
}
