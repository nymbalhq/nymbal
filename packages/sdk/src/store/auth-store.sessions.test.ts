import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Customer, CustomerSession } from '@nymbalhq/types'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import { SESSION_HINT_KEY } from '../auth/session.js'
import { createTokenManager, type TokenManager } from '../auth/token-manager.js'
import { createAuthStore, type AuthStore } from './auth-store.js'

// The auth store's signed-in devices: the list, the end of one session, and the end of every session. Ending this
// device's session, or every session, leaves the store as a sign-out does, but only once the store has said yes: a
// refused request rejects and leaves the shopper signed in. Ending another device's session leaves this one signed in.
// Each store runs on a real token manager and a Web Storage of its own (the session hint lives there).

const CUSTOMER: Customer = {
  id: 'cust-1',
  email: 'ada@example.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  phone: '',
  addresses: [],
  orderCount: 0,
  totalSpentMinor: 0,
  metadata: {},
  roles: ['customer'],
  requiresPasswordReset: false,
  createdAt: '',
  updatedAt: '',
}

const SESSIONS: CustomerSession[] = [
  {
    id: 'ses-this',
    device: 'Firefox on Windows',
    signedInAt: '2026-11-01T09:00:00.000Z',
    lastActiveAt: '2026-11-20T09:00:00.000Z',
    current: true,
  },
  {
    id: 'ses-phone',
    device: 'Safari on iPhone',
    signedInAt: '2026-10-01T09:00:00.000Z',
    lastActiveAt: '2026-11-19T09:00:00.000Z',
    current: false,
  },
]

function storage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key)
    },
    setItem: (key, value) => {
      items.set(key, value)
    },
  }
}

type Answer = { ok: true; value: unknown } | { ok: false; message: string }

const answered = (answer: Answer) =>
  vi.fn(async () => {
    if (!answer.ok) throw new Error(answer.message)
    return answer.value
  })

function adapterAnswering(answers: { end?: Answer; endAll?: Answer; list?: Answer } = {}) {
  const customers = {
    login: vi.fn(async () => ({
      customer: CUSTOMER,
      accessToken: 'token-signed-in',
      refreshToken: '',
      expiresIn: 900,
    })),
    logout: vi.fn(async () => undefined),
    listSessions: answered(answers.list ?? { ok: true, value: SESSIONS }),
    endSession: answered(answers.end ?? { ok: true, value: { ended: true, current: false } }),
    endAllSessions: answered(answers.endAll ?? { ok: true, value: { ended: 'all' } }),
  }
  return { adapter: { customers } as unknown as CommerceAdapter, customers }
}

const tokenManagers: TokenManager[] = []

beforeEach(() => {
  vi.stubGlobal('localStorage', storage())
})

afterEach(() => {
  for (const manager of tokenManagers.splice(0)) manager.destroy()
  vi.unstubAllGlobals()
})

/** A store signed in through `login`, so it holds a token, the session hint and the customer. */
async function signedIn(
  adapter: CommerceAdapter,
): Promise<{ store: AuthStore; tokens: TokenManager }> {
  const tokens = createTokenManager({ storage: 'memory' })
  tokenManagers.push(tokens)
  const store = createAuthStore(adapter, tokens, async () => undefined)
  await store.login(CUSTOMER.email, 'correct-horse')
  return { store, tokens }
}

/** What the shopper's browser holds: the store's state, its token and the session hint. */
const held = (store: AuthStore, tokens: TokenManager) => ({
  state: store.getState(),
  token: tokens.getAccessToken(),
  hint: localStorage.getItem(SESSION_HINT_KEY),
})

/** What a sign-out leaves, read from a twin store signed in the same way. */
async function afterLogout() {
  vi.stubGlobal('localStorage', storage())
  const { adapter } = adapterAnswering()
  const twin = await signedIn(adapter)
  await twin.store.logout()
  const left = held(twin.store, twin.tokens)
  vi.stubGlobal('localStorage', storage())
  return left
}

describe('AC-12: the auth store’s devices', () => {
  // Defect: the store answers its own copy or a reshaped list, not the store API's.
  it('AC-12: property: sessions() answers the adapter’s list', async () => {
    const session = fc.record({
      id: fc.uuid(),
      device: fc.string(),
      signedInAt: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
      lastActiveAt: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
      current: fc.boolean(),
    })
    await fc.assert(
      fc.asyncProperty(fc.array(session, { maxLength: 5 }), async (list) => {
        const { adapter } = adapterAnswering({ list: { ok: true, value: list } })
        const { store } = await signedIn(adapter)

        expect(await store.sessions()).toEqual(list)
      }),
      { numRuns: 25 },
    )
  })

  // Defect: ending another device's session signs this one out, or ends a session other than the one asked.
  it('AC-12: endSession of another device (answer current: false) asks for that id and leaves this store signed in, its token and the session hint held', async () => {
    const { adapter, customers } = adapterAnswering()
    const { store, tokens } = await signedIn(adapter)
    const before = held(store, tokens)

    await store.endSession('ses-phone')

    expect(customers.endSession.mock.calls).toEqual([['ses-phone']])
    expect(held(store, tokens)).toEqual(before)
    expect(store.getState().isAuthenticated).toBe(true)
  })

  // Defect: the page still reads as signed in after its own session ended, or the store keeps a token the API ended.
  it.each([
    {
      call: 'endSession of this device (answer current: true)',
      answers: { end: { ok: true, value: { ended: true, current: true } } as Answer },
      act: (store: AuthStore) => store.endSession('ses-this'),
    },
    {
      call: 'signOutEverywhere',
      answers: {},
      act: (store: AuthStore) => store.signOutEverywhere(),
    },
  ])(
    'AC-12: $call succeeding leaves the store as logout does: no token, no session hint, customer null',
    async ({ answers, act }) => {
      const expected = await afterLogout()
      const { adapter } = adapterAnswering(answers)
      const { store, tokens } = await signedIn(adapter)

      await act(store)

      expect(held(store, tokens)).toEqual(expected)
      expect(expected).toMatchObject({ token: null, hint: null, state: { customer: null } })
    },
  )

  // Defect: the shopper is told they signed out (and the page drops the session) when the request failed.
  it('AC-12: property: endSession of either device and signOutEverywhere, refused with any message, reject with it and leave the token, the hint and the customer as they were', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('endSession this', 'endSession other', 'signOutEverywhere'),
        fc.string({ minLength: 1 }),
        async (call, message) => {
          vi.stubGlobal('localStorage', storage())
          const refused: Answer = { ok: false, message }
          const { adapter } = adapterAnswering({ end: refused, endAll: refused })
          const { store, tokens } = await signedIn(adapter)
          const before = held(store, tokens)

          const act =
            call === 'signOutEverywhere'
              ? store.signOutEverywhere()
              : store.endSession(call === 'endSession this' ? 'ses-this' : 'ses-phone')

          await expect(act).rejects.toThrow(message)
          const after = held(store, tokens)
          expect([
            after.token,
            after.hint,
            after.state.customer,
            after.state.isAuthenticated,
          ]).toEqual([
            before.token,
            before.hint,
            before.state.customer,
            before.state.isAuthenticated,
          ])
        },
      ),
      { numRuns: 30 },
    )
  })
})
