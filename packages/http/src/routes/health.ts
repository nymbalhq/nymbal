import type { RouteHandler } from '@nymbalhq/types'

export function createHealthRoute(version: string): RouteHandler {
  return () => ({
    status: 200,
    body: { status: 'ok', version, timestamp: new Date().toISOString() },
  })
}
