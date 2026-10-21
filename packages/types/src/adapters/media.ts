import type { HealthReport } from './adapter-base.js'

/** Where uploaded and imported media go. `put` returns the URL the stored bytes are served from. */
export interface MediaStorage {
  capabilities(): readonly string[]
  put(key: string, body: Uint8Array, contentType: string): Promise<{ url: string }>
  /**
   * Whether `put` can store, checked without storing anything, within `HEALTH_CHECK_TIMEOUT_MS`. Optional, so a
   * storage written before it existed still type-checks; `nymbal doctor` reports one without it as `no healthCheck`.
   */
  healthCheck?(): Promise<HealthReport>
}
