import { describe, it, expect, vi } from 'vitest'
import { createTokenManager } from './token-manager.js'

describe('TokenManager', () => {
  it('initial access token is null', () => {
    const tm = createTokenManager({ storage: 'memory' })
    expect(tm.getAccessToken()).toBeNull()
    tm.destroy()
  })

  it('setTokens stores access token in memory', () => {
    const tm = createTokenManager({ storage: 'memory' })
    tm.setTokens('access-token-abc', 900)
    expect(tm.getAccessToken()).toBe('access-token-abc')
    tm.destroy()
  })

  it('clear removes stored token', () => {
    const tm = createTokenManager({ storage: 'memory' })
    tm.setTokens('tok', 900)
    tm.clear()
    expect(tm.getAccessToken()).toBeNull()
    tm.destroy()
  })

  it('scheduleRefresh calls refreshFn before expiry', async () => {
    vi.useFakeTimers()
    try {
      const tm = createTokenManager({ storage: 'memory' })
      const refreshFn = vi.fn().mockResolvedValue({ accessToken: 'new-tok', expiresIn: 900 })
      tm.setTokens('old-tok', 1) // delay = Math.max(1000, 800) = 1000ms
      tm.scheduleRefresh(refreshFn)
      // Advance past the 1000ms minimum delay (see token-manager: Math.max(1000, expiresIn*0.8*1000))
      await vi.advanceTimersByTimeAsync(1100)
      expect(refreshFn).toHaveBeenCalled()
      expect(tm.getAccessToken()).toBe('new-tok')
      tm.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('destroy cancels pending refresh', () => {
    const tm = createTokenManager({ storage: 'memory' })
    const refreshFn = vi.fn().mockResolvedValue({ accessToken: 'new', expiresIn: 900 })
    tm.setTokens('tok', 3600)
    tm.scheduleRefresh(refreshFn)
    tm.destroy()
    expect(refreshFn).not.toHaveBeenCalled()
  })
})
