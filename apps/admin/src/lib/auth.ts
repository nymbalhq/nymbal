// api.ts imports this module too; both use the other's exports only inside functions.
import { fetchWithCsrf } from '@/lib/api'

// The access token lives in memory only; the httpOnly `nymbal.refresh` cookie restores it after a reload.
let _token: string | null = null
let inFlight: Promise<boolean> | null = null
const sessionLostListeners = new Set<() => void>()

export function setToken(token: string): void {
  _token = token
}

export function getToken(): string | null {
  return _token
}

export function clearToken(): void {
  _token = null
}

export function isAuthenticated(): boolean {
  return _token !== null
}

/** Called once per failed refresh; returns the unsubscribe function. */
export function onSessionLost(listener: () => void): () => void {
  sessionLostListeners.add(listener)
  return () => {
    sessionLostListeners.delete(listener)
  }
}

/** Whether `token` belongs to an admin; anything else, an unreachable API included, is a no. */
async function isAdminToken(token: string): Promise<boolean> {
  try {
    const response = await fetch('/api/admin/me', { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) return false
    const body = (await response.json()) as { data?: { roles?: string[] } }
    return body.data?.roles?.includes('admin') ?? false
  } catch {
    return false
  }
}

/**
 * The refresh cookie is per host, so it may be a storefront customer's: the token it yields is adopted only after the
 * admin role check.
 */
async function requestRefresh(): Promise<boolean> {
  let token: string | undefined
  try {
    const response = await fetchWithCsrf('/api/auth/refresh', { method: 'POST' })
    if (!response.ok) return false
    const body = (await response.json()) as { data?: { accessToken?: string } }
    token = body.data?.accessToken
  } catch {
    return false
  }
  if (!token || !(await isAdminToken(token))) return false
  setToken(token)
  return true
}

/**
 * One refresh at a time: the server rotates the refresh token, and a rotated token sent twice revokes the whole
 * chain, so concurrent callers share the request in flight.
 */
function sharedRefresh(notifyOnFailure: boolean): Promise<boolean> {
  inFlight ??= requestRefresh().then((ok) => {
    inFlight = null
    if (!ok) {
      clearToken()
      if (notifyOnFailure) for (const listener of [...sessionLostListeners]) listener()
    }
    return ok
  })
  return inFlight
}

export function refreshSession(): Promise<boolean> {
  return sharedRefresh(true)
}

/** At boot: a refresh (role-checked like every refresh). A failure here is a signed-out boot, not a lost session. */
export function restoreSession(): Promise<boolean> {
  return sharedRefresh(false)
}
