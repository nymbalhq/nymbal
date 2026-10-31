import type { NymbalClient } from '@nymbalhq/sdk'
import { onStoreBuilt } from '@nymbalhq/sdk/core'

const CLIENT_KEY = Symbol.for('nymbal.client')

/**
 * The registered clients' stores that have had a settled update (one that is not `loading`). A store starts at
 * `loading: false` before anything loaded it, so its state alone cannot tell an element connecting later whether the
 * store's data has replaced what a server rendered.
 */
const settledStores = new WeakSet<object>()

export function registerClient(client: NymbalClient): void {
  ;(globalThis as Record<symbol, unknown>)[CLIENT_KEY] = client
  // A store the page builds after this (its first read) is subscribed then; reading one here would build it.
  onStoreBuilt(client, (store) => {
    store.subscribe(() => {
      if ((store.getState() as { loading?: unknown }).loading !== true) settledStores.add(store)
    })
  })
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
