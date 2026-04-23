import type { NymbalClient } from '@nymbal/sdk'

const CLIENT_KEY = Symbol.for('nymbal.client')

export function registerClient(client: NymbalClient): void {
  (globalThis as Record<symbol, unknown>)[CLIENT_KEY] = client
}

export function getClient(): NymbalClient {
  const client = (globalThis as Record<symbol, unknown>)[CLIENT_KEY] as NymbalClient | undefined
  if (!client) {
    throw new Error('NymbalClient not registered. Call registerClient() before using components.')
  }
  return client
}
