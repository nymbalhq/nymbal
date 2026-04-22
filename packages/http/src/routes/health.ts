import type { RouteHandler } from '@nymbal/types'

export function createHealthRoute(version: string): RouteHandler {
  return () => ({
    status: 200,
    body: { status: 'ok', version, timestamp: new Date().toISOString() },
  })
}
