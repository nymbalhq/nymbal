import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HttpAdapter } from '@nymbalhq/types'
import { routeSchemas } from './schemas.js'
import type * as SchemasModule from './schemas.js'
import { createKernel } from '../../tests/support/kernel.js'

// P1-06 AC-13 and AC-14: the schema registry is exactly the set of routes `attachHttp` registers (plain and stream,
// with the production-only admin routes), and a route with no entry stops startup. Kills: a route without a schema,
// a stale entry, stream routes skipped, a missing schema skipped silently.

/** An adapter that serves nothing and records every `"<METHOD> <path>"` registered on it. */
function recordingAdapter(): { adapter: HttpAdapter; keys: string[] } {
  const keys: string[] = []
  const adapter: HttpAdapter = {
    registerRoute(method, path) {
      keys.push(`${method} ${path}`)
    },
    registerStreamRoute(method, path) {
      keys.push(`${method} ${path}`)
    },
    registerMiddleware() {},
    setDefaultHeaders() {},
    async start() {},
    async stop() {},
  }
  return { adapter, keys }
}

/** Runs `fn` with NODE_ENV=production, restoring the previous value afterwards. */
async function inProduction<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env['NODE_ENV']
  process.env['NODE_ENV'] = 'production'
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = previous
  }
}

afterEach(() => {
  vi.doUnmock('./schemas.js')
  vi.resetModules()
})

describe('route schema registry', () => {
  it('AC-13: the keys attachHttp registers in production (registerRoute and registerStreamRoute) equal the keys of routeSchemas; every name is unique and every description non-empty', async () => {
    const kernel = await createKernel({ dialect: 'sqlite' })
    try {
      const { adapter, keys } = recordingAdapter()
      await inProduction(() => kernel.app.attachHttp(adapter))

      expect(keys).toContain('GET /admin')
      expect(keys).toContain('GET /admin/*')
      expect(keys).toContain('GET /api/admin/events')
      const registered = [...new Set(keys)].sort()
      expect(registered).toHaveLength(keys.length)
      expect(Object.keys(routeSchemas).sort()).toEqual(registered)

      const entries = Object.values(routeSchemas)
      expect(new Set(entries.map((entry) => entry.name)).size).toBe(entries.length)
      for (const [key, entry] of Object.entries(routeSchemas)) {
        expect(entry.description.trim().length, key).toBeGreaterThan(0)
      }
    } finally {
      await kernel.close()
    }
  })

  it('AC-14: a route registered with no registry entry makes attachHttp reject with config.route_schema_missing naming its method and path', async () => {
    const dropped = 'POST /api/cart/items'
    vi.resetModules()
    vi.doMock('./schemas.js', async (importOriginal) => {
      const real = await importOriginal<typeof SchemasModule>()
      const routeSchemas = { ...real.routeSchemas }
      delete routeSchemas[dropped]
      return { ...real, routeSchemas }
    })
    const { createKernel: freshKernel } = await import('../../tests/support/kernel.js')
    const kernel = await freshKernel({ dialect: 'sqlite' })
    try {
      const { adapter } = recordingAdapter()
      const failure = await kernel.app.attachHttp(adapter).then(
        () => undefined,
        (error: unknown) => error as { code?: string; message?: string },
      )
      expect(failure, 'attachHttp resolved with a route missing from the registry').toBeDefined()
      expect(failure!.code).toBe('config.route_schema_missing')
      expect(failure!.message).toContain('POST')
      expect(failure!.message).toContain('/api/cart/items')
    } finally {
      await kernel.close()
    }
  })
})
