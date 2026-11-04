import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getNymbalClient } from '@/lib/client'

// AC-5, the Next storefront's half: the browser client the template makes keeps the shopper's access token in memory.
// After a sign-in or a refresh no localStorage or sessionStorage key or value holds it, so a script injected into a
// page finds nothing in Web Storage that signs in as the shopper.

const local = new Map<string, string>()
const session = new Map<string, string>()
let nextToken = ''

function storageOf(items: Map<string, string>): Storage {
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, String(value)),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
    key: (i: number) => [...items.keys()][i] ?? null,
    get length() {
      return items.size
    },
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeAll(() => {
  vi.stubGlobal('localStorage', storageOf(local))
  vi.stubGlobal('sessionStorage', storageOf(session))
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname
    if (path === '/api/csrf') return json(200, { data: { token: 'csrf-token' } })
    if (path === '/api/auth/login') {
      return json(200, {
        data: {
          customer: { id: 'cus-1', email: 'ada@shop.test', firstName: 'Ada', lastName: 'L' },
          accessToken: nextToken,
          expiresIn: 900,
        },
      })
    }
    if (path === '/api/auth/refresh')
      return json(200, { data: { accessToken: nextToken, expiresIn: 900 } })
    return json(200, { data: null })
  })
})

afterAll(() => {
  getNymbalClient().destroy()
  vi.unstubAllGlobals()
})

/** Every key and value in either storage that contains the token. */
const holding = (token: string) => [...local, ...session].flat().filter((e) => e.includes(token))

const tokens = fc.stringMatching(/^[A-Za-z0-9_-]{12,40}\.[A-Za-z0-9_-]{8,40}\.[A-Za-z0-9_-]{8,40}$/)

describe('AC-5: the Next storefront’s client keeps the access token out of Web Storage', () => {
  // Kills: the template's `tokenStorage: 'localStorage'` (lib/client.ts), which leaves the token for any script to read.
  it('AC-5: property: after a sign-in and after a refresh through getNymbalClient(), no Web Storage key or value holds the token issued', async () => {
    await fc.assert(
      fc.asyncProperty(tokens, tokens, async (signedIn, refreshed) => {
        const client = getNymbalClient()

        nextToken = signedIn
        await client.auth.login('ada@shop.test', 'pw')
        const afterLogin = holding(signedIn)
        nextToken = refreshed
        await client.auth.refreshToken()
        const afterRefresh = holding(refreshed)

        expect({ afterLogin, afterRefresh }).toEqual({ afterLogin: [], afterRefresh: [] })
      }),
      { numRuns: 10 },
    )
  })
})
