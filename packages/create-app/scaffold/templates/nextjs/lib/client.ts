import { createNymbalClient, type NymbalClient } from '@nymbalhq/sdk'

// A payment driver of the project's own is registered here, at module load, before any checkout renders:
// registerPaymentDriver(name, driver) from @nymbalhq/sdk, named by the driver of the payments adapter's client half.

let instance: NymbalClient | null = null
let restoring: Promise<void> = Promise.resolve()

/** In the browser, the first call starts restoring the session: requests sent meanwhile wait for it. */
export function getNymbalClient(): NymbalClient {
  if (!instance) {
    instance = createNymbalClient({
      baseUrl: process.env.NEXT_PUBLIC_NYMBAL_API_URL ?? 'http://localhost:3001',
    })
    if (typeof window !== 'undefined') restoring = instance.auth.restore()
  }
  return instance
}

/** The page load's session restore, which the account guard awaits before deciding to redirect. */
export function restoreSession(): Promise<void> {
  getNymbalClient()
  return restoring
}
