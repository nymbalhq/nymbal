import { ACCESS_TOKEN_KEY, markSession } from './session.js'

/** A refresh: its token for the manager to hold, or nothing when it has set (or cleared) the token itself. */
type RefreshFn = () => Promise<{ accessToken: string; expiresIn: number } | void>

export interface TokenManagerOptions {
  storage?: 'memory' | 'localStorage'
  storageKey?: string
}

export interface TokenManager {
  getAccessToken(): string | null
  setTokens(accessToken: string, expiresIn: number): void
  clear(): void
  scheduleRefresh(refreshFn: RefreshFn): void
  destroy(): void
}

export function createTokenManager(options?: TokenManagerOptions): TokenManager {
  const storageMode = options?.storage ?? 'memory'
  const storageKey = options?.storageKey ?? ACCESS_TOKEN_KEY

  let memoryToken: string | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let refreshFn: RefreshFn | null = null

  function getAccessToken(): string | null {
    if (storageMode === 'localStorage' && typeof globalThis.localStorage !== 'undefined') {
      return globalThis.localStorage.getItem(storageKey)
    }
    return memoryToken
  }

  function setAccessToken(token: string | null): void {
    memoryToken = token
    if (storageMode === 'localStorage' && typeof globalThis.localStorage !== 'undefined') {
      if (token) {
        globalThis.localStorage.setItem(storageKey, token)
      } else {
        globalThis.localStorage.removeItem(storageKey)
      }
    }
  }

  function setTokens(accessToken: string, expiresIn: number): void {
    setAccessToken(accessToken)
    markSession()
    scheduleAutoRefresh(expiresIn)
  }

  function clear(): void {
    setAccessToken(null)
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
  }

  function scheduleAutoRefresh(expiresIn: number): void {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer)
    }
    const delayMs = Math.max(1000, expiresIn * 0.8 * 1000)
    refreshTimer = setTimeout(async () => {
      if (!refreshFn) return
      try {
        const result = await refreshFn()
        if (result) setTokens(result.accessToken, result.expiresIn)
      } catch (err) {
        console.error('[TokenManager] auto-refresh failed, clearing session', err)
        clear()
      }
    }, delayMs)
  }

  function scheduleRefresh(fn: RefreshFn): void {
    refreshFn = fn
  }

  function destroy(): void {
    clear()
    refreshFn = null
  }

  return { getAccessToken, setTokens, clear, scheduleRefresh, destroy }
}
