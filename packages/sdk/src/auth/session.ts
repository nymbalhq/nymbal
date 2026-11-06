import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import { NymbalApiError } from '../adapter/fetch-client.js'
import type { TokenManager } from './token-manager.js'

/**
 * Set in `localStorage` while the browser holds a session the refresh cookie can bring back. It holds no token: a page
 * load with no hint is a guest's, and restores nothing.
 */
export const SESSION_HINT_KEY = 'nymbal.auth.session'

/** Where `tokenStorage: 'localStorage'` keeps the access token, and where every client kept it before. */
export const ACCESS_TOKEN_KEY = 'nymbal.auth.accessToken'

/** Runs `use` on `localStorage`, or answers `fallback` where there is none or it throws (a locked-down window). */
function withStorage<T>(use: (storage: Storage) => T, fallback: T): T {
  try {
    return typeof globalThis.localStorage === 'undefined' ? fallback : use(globalThis.localStorage)
  } catch {
    return fallback
  }
}

export function hasSessionHint(): boolean {
  return withStorage((storage) => storage.getItem(SESSION_HINT_KEY) === '1', false)
}

export function markSession(): void {
  withStorage((storage) => storage.setItem(SESSION_HINT_KEY, '1'), undefined)
}

export function forgetSession(): void {
  withStorage((storage) => storage.removeItem(SESSION_HINT_KEY), undefined)
}

/** Removes an access token an earlier version kept in `localStorage`; the shopper it belonged to keeps their session. */
export function adoptLegacyToken(): void {
  withStorage((storage) => {
    if (storage.getItem(ACCESS_TOKEN_KEY) === null) return
    storage.removeItem(ACCESS_TOKEN_KEY)
    storage.setItem(SESSION_HINT_KEY, '1')
  }, undefined)
}

/** The API refused the session itself, as against a refresh that never reached it or that it failed to answer. */
export function isSessionRefusal(err: unknown): boolean {
  return err instanceof NymbalApiError && (err.status === 401 || err.status === 403)
}

/**
 * One refresh from the refresh cookie. It never throws: a failure leaves no token, and forgets the session only when
 * the API refused it, so an API that is down or restarting signs no one out for good.
 */
export async function renewSession(
  adapter: CommerceAdapter,
  tokenManager: TokenManager,
): Promise<void> {
  try {
    const result = await adapter.customers.refresh()
    tokenManager.setTokens(result.accessToken, result.expiresIn)
  } catch (err) {
    console.warn('[NymbalClient] token refresh failed', err)
    tokenManager.clear()
    if (isSessionRefusal(err)) forgetSession()
  }
}
