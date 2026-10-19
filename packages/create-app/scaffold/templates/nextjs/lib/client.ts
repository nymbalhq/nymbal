import { createNymbalClient, type NymbalClient } from '@nymbalhq/sdk'

let instance: NymbalClient | null = null
let restoring: Promise<void> | null = null

export function getNymbalClient(): NymbalClient {
  if (!instance) {
    instance = createNymbalClient({
      baseUrl: process.env.NEXT_PUBLIC_NYMBAL_API_URL ?? 'http://localhost:3001',
      tokenStorage: 'localStorage',
    })
  }
  return instance
}

/**
 * Loads the profile for a stored token once per page load, so a reload keeps a signed-in shopper signed in.
 * The account guard awaits the same promise before deciding to redirect.
 */
export function restoreSession(): Promise<void> {
  restoring ??= getNymbalClient().auth.loadProfile()
  return restoring
}
