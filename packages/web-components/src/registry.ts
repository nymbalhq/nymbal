import type { NymbalClient } from '@nymbalhq/sdk'

const CLIENT_KEY = Symbol.for('nymbal.client')

export function registerClient(client: NymbalClient): void {
  (globalThis as Record<symbol, unknown>)[CLIENT_KEY] = client
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
