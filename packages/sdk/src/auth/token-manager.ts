export interface TokenManagerOptions {
  storage?: 'memory' | 'localStorage'
  storageKey?: string
}

export interface TokenManager {
  getAccessToken(): string | null
  setTokens(accessToken: string, expiresIn: number): void
  clear(): void
  scheduleRefresh(refreshFn: () => Promise<{ accessToken: string; expiresIn: number }>): void
  destroy(): void
}

const DEFAULT_STORAGE_KEY = 'nymbal.auth.accessToken'

export function createTokenManager(options?: TokenManagerOptions): TokenManager {
  const storageMode = options?.storage ?? 'memory'
  const storageKey = options?.storageKey ?? DEFAULT_STORAGE_KEY

  let memoryToken: string | null = null
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let refreshFn: (() => Promise<{ accessToken: string; expiresIn: number }>) | null = null

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
        setTokens(result.accessToken, result.expiresIn)
      } catch (err) {
        console.error('[TokenManager] auto-refresh failed, clearing session', err)
        clear()
      }
    }, delayMs)
  }

  function scheduleRefresh(
    fn: () => Promise<{ accessToken: string; expiresIn: number }>,
  ): void {
    refreshFn = fn
  }

  function destroy(): void {
    clear()
    refreshFn = null
  }

  return { getAccessToken, setTokens, clear, scheduleRefresh, destroy }
}
