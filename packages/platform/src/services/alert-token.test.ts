import { describe, expect, it } from 'vitest'
import { newAlertToken } from './alert-token.js'

// A confirm or unsubscribe link's token is a bearer credential for one address's alert on one variant: 32 random bytes,
// base64url, so it can be neither guessed nor derived from another token, a counter or the clock.

const CALLS = 1000
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/

describe('newAlertToken', () => {
  it('AC-3: property: over 1000 calls each token is 43 base64url characters decoding to 32 bytes, and no two are equal', () => {
    const tokens = Array.from({ length: CALLS }, () => newAlertToken())

    for (const token of tokens) {
      expect(token, token).toMatch(BASE64URL_43)
      const bytes = Buffer.from(token, 'base64url')
      expect(bytes.length, token).toBe(32)
      // The token is the canonical encoding of its bytes: nothing is padded or appended.
      expect(bytes.toString('base64url'), token).toBe(token)
    }
    expect(new Set(tokens).size).toBe(tokens.length)
  })

  it('AC-3: tokens minted back to back share no common prefix longer than chance allows, so none is a counter or a timestamp', () => {
    const tokens = Array.from({ length: CALLS }, () => newAlertToken())
    const prefix = (a: string, b: string): number => {
      let n = 0
      while (n < a.length && a[n] === b[n]) n += 1
      return n
    }
    const longest = Math.max(...tokens.slice(1).map((t, i) => prefix(tokens[i]!, t)))
    // 64 symbols a character: a shared prefix of 4 between neighbours has odds near 1 in 16 million per pair.
    expect(longest).toBeLessThan(4)
  })
})
