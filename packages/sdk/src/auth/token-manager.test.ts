import fc from 'fast-check'
import { describe, it, expect, vi } from 'vitest'
import { createTokenManager } from './token-manager.js'

describe('TokenManager', () => {
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

  it('property: the scheduled refresh replaces the token no sooner than 1 s and no later than its expiry', async () => {
    vi.useFakeTimers()
    try {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 3600 }), async (expiresIn) => {
          const tm = createTokenManager({ storage: 'memory' })
          tm.scheduleRefresh(async () => ({ accessToken: 'new-tok', expiresIn: 900 }))
          tm.setTokens('old-tok', expiresIn)
          await vi.advanceTimersByTimeAsync(999)
          expect(tm.getAccessToken()).toBe('old-tok')
          await vi.advanceTimersByTimeAsync(expiresIn * 1000 - 999)
          expect(tm.getAccessToken()).toBe('new-tok')
          tm.destroy()
        }),
        { numRuns: 30 },
      )
    } finally {
      vi.useRealTimers()
    }
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

  it('destroy cancels a pending refresh: past its time no refreshed token appears', async () => {
    vi.useFakeTimers()
    try {
      const tm = createTokenManager({ storage: 'memory' })
      const refreshFn = vi.fn().mockResolvedValue({ accessToken: 'new', expiresIn: 900 })
      tm.setTokens('tok', 1)
      tm.scheduleRefresh(refreshFn)
      tm.destroy()
      await vi.advanceTimersByTimeAsync(1100)
      expect(tm.getAccessToken()).toBeNull()
      expect(refreshFn).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
