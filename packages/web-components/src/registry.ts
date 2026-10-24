import type { NymbalClient } from '@nymbalhq/sdk'

const CLIENT_KEY = Symbol.for('nymbal.client')

interface Store {
  subscribe(fn: () => void): () => void
  getState(): unknown
}

function isStore(value: unknown): value is Store {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Store).subscribe === 'function' &&
    typeof (value as Store).getState === 'function'
  )
}

/**
 * The registered clients' stores that have had a settled update (one that is not `loading`). A store starts at
 * `loading: false` before anything loaded it, so its state alone cannot tell an element connecting later whether the
 * store's data has replaced what a server rendered.
 */
const settledStores = new WeakSet<object>()

export function registerClient(client: NymbalClient): void {
  ;(globalThis as Record<symbol, unknown>)[CLIENT_KEY] = client
  for (const store of Object.values(client)) {
    if (!isStore(store)) continue
    store.subscribe(() => {
      if ((store.getState() as { loading?: unknown }).loading !== true) settledStores.add(store)
    })
  }
}

/** Whether a registered client's store has had a settled update since the client was registered. */
export function hasSettled(store: object): boolean {
  return settledStores.has(store)
}

/** Whether a client is registered: never on a server, which renders elements from their properties. */
export function hasClient(): boolean {
  return (globalThis as Record<symbol, unknown>)[CLIENT_KEY] !== undefined
}

export function getClient(): NymbalClient {
  const client = (globalThis as Record<symbol, unknown>)[CLIENT_KEY] as NymbalClient | undefined
  if (!client) {
    throw new Error('NymbalClient not registered. Call registerClient() before using components.')
  }
  return client
}
