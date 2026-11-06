import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNymbalClient, type NymbalClient } from '../src/index.js'
import { BASE, endStubs, fakeSessionApi, HINT, LEGACY_KEY, stubStorages } from './session-api.js'

// AC-5: a client made as the storefronts make it (no `tokenStorage`) keeps the shopper's access token in memory only:
// after a login, a registration and a refresh no localStorage or sessionStorage key or value holds it, only the
// session hint, which holds no token. A token an earlier version left under `nymbal.auth.accessToken` is removed when
// the client is made, and the hint is set in its place, so the upgraded shopper's next restore signs them in.

const clients: NymbalClient[] = []
const made = (): NymbalClient => {
  const client = createNymbalClient({ baseUrl: BASE })
  clients.push(client)
  return client
}

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy()
  endStubs()
  vi.restoreAllMocks()
})

const tokens = fc.stringMatching(/^[A-Za-z0-9_-]{12,40}\.[A-Za-z0-9_-]{8,40}\.[A-Za-z0-9_-]{8,40}$/)

describe('AC-5: the access token lives in memory only', () => {
  // Kills: a client that writes the token to Web Storage (the templates' `tokenStorage: 'localStorage'`), under any
  // key, after any of the three ways a token arrives; and one that keeps no hint, so the next page load is signed out.
  it('AC-5: property: after login, register and a refresh, no Web Storage key or value holds any token issued, and the session hint is "1"', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(tokens, { minLength: 3, maxLength: 3 }), async (issued) => {
        const storages = stubStorages()
        const api = fakeSessionApi()
        const queue = [...issued]
        api.mint = () => queue.shift()!
        const client = createNymbalClient({ baseUrl: BASE })
        const after: Array<{ step: string; holding: string[]; hint: string | null }> = []
        const look = (step: string) =>
          after.push({
            step,
            holding: api.issued.flatMap((t) => storages.holding(t)),
            hint: storages.local.get(HINT) ?? null,
          })
        try {
          await client.auth.login('ada@session.test', 'pw')
          look('login')
          await client.auth.register({ email: 'ada@session.test', password: 'pw' })
          look('register')
          await client.auth.refreshToken()
          look('refresh')
        } finally {
          client.destroy()
          endStubs()
        }

        expect(api.issued).toEqual(issued)
        expect(after).toEqual(
          ['login', 'register', 'refresh'].map((step) => ({ step, holding: [], hint: '1' })),
        )
      }),
      { numRuns: 15 },
    )
  })

  // Kills: the legacy key left in place (an injected script still reads a live token), or removed with no hint
  // written (the upgraded shopper is signed out on their next page).
  it('AC-5: a nymbal.auth.accessToken left by an earlier version is removed when the client is made, the hint is set in its place, and the shopper’s restore then signs them in; with no legacy key no hint is written', async () => {
    const upgraded = stubStorages({ local: { [LEGACY_KEY]: 'legacy.access.token' } })
    const api = fakeSessionApi()
    const client = made()
    const afterCreate = {
      legacy: upgraded.local.get(LEGACY_KEY) ?? null,
      hint: upgraded.local.get(HINT) ?? null,
    }
    expect(afterCreate).toEqual({ legacy: null, hint: '1' })

    await client.auth.restore()

    expect(api.refreshes()).toBe(1)
    expect(client.auth.getState().isAuthenticated).toBe(true)
    expect(upgraded.holding('legacy.access.token')).toEqual([])

    endStubs()
    const fresh = stubStorages()
    fakeSessionApi()
    made()
    expect([...fresh.local.keys()]).toEqual([])
  })
})
