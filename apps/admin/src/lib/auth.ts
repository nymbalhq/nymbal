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

async function requestRefresh(): Promise<boolean> {
  try {
    const response = await fetchWithCsrf('/api/auth/refresh', { method: 'POST' })
    if (!response.ok) return false
    const body = (await response.json()) as { data?: { accessToken?: string } }
    const token = body.data?.accessToken
    if (!token) return false
    setToken(token)
    return true
  } catch {
    return false
  }
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

/** At boot: a refresh, then the admin role check. Anything but an admin leaves the session signed out. */
export async function restoreSession(): Promise<boolean> {
  if (!(await sharedRefresh(false))) return false
  try {
    const response = await fetch('/api/admin/me', {
      headers: { Authorization: `Bearer ${_token ?? ''}` },
    })
    if (response.ok) {
      const body = (await response.json()) as { data?: { roles?: string[] } }
      if (body.data?.roles?.includes('admin')) return true
    }
  } catch {
    // An unreachable API is a signed-out boot, not a crash.
  }
  clearToken()
  return false
}
