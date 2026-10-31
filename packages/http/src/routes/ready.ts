import type { RouteHandler } from '@nymbalhq/types'

export type ReadyState = { ready: true } | { ready: false; failing: string[] }

/** GET /ready: 200 when the store can take traffic, else 503 naming what cannot, by name only. */
export function createReadyRoute(probe: () => Promise<ReadyState>): RouteHandler {
  return async () => {
    const state = await probe()
    return state.ready
      ? { status: 200, body: { status: 'ready' } }
      : { status: 503, body: { status: 'not-ready', failing: state.failing } }
  }
}
