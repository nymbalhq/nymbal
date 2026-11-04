import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_HINT_KEY as CORE_HINT_KEY } from '../src/core.js'
import { createNymbalClient, SESSION_HINT_KEY, type NymbalClient } from '../src/index.js'
import {
  BASE,
  CUSTOMER,
  endStubs,
  fakeSessionApi,
  HINT,
  REFRESH,
  settle,
  stubStorages,
  type RefreshAnswer,
} from './session-api.js'

// AC-6: `auth.restore()` brings a signed-in shopper's session back on a page load from the refresh cookie alone. With
// no token and the session hint set it refreshes once and loads the profile; with no hint it sends nothing (a guest's
// page load); a refresh the API refuses with its 401 or 403 envelope signs out and removes the hint, so the next page
// load sends nothing; a refresh lost in transport, or a 5xx, signs out this page load and keeps the hint; a held token
// loads the profile with no refresh. Login and register set the hint and logout removes it; the 401 path and the
// timer follow the same rule as restore. No case throws.

const clients: NymbalClient[] = []
const made = (): NymbalClient => {
  const client = createNymbalClient({ baseUrl: BASE })
  clients.push(client)
  return client
}

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy()
  vi.useRealTimers()
  endStubs()
  vi.restoreAllMocks()
})

const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

const settledOf = (call: Promise<unknown>) =>
  call.then(
    () => 'resolved',
    (err: unknown) => `threw ${String(err)}`,
  )

describe('AC-6: restore() on a page load', () => {
  // Kills: restore as loadProfile, which returns at once with no token (the reloaded shopper reads as signed out).
  it('AC-6: no token and the hint set: one POST /api/auth/refresh, the profile read with the token it issued, signed in as that customer', async () => {
    stubStorages({ local: { [HINT]: '1' } })
    const api = fakeSessionApi()
    const client = made()

    await client.auth.restore()

    expect(api.refreshes()).toBe(1)
    expect(api.bearersTo('/api/customers/me')).toEqual([`Bearer ${api.issued[0]}`])
    expect(client.auth.getState()).toMatchObject({ isAuthenticated: true, customer: CUSTOMER })
  })

  // Kills: a restore that refreshes for every visitor (a 401 and a console error per guest page view).
  it('AC-6: no token and no hint: restore sends no request at all and resolves signed out', async () => {
    const storages = stubStorages()
    const api = fakeSessionApi()
    const client = made()

    const outcome = await settledOf(client.auth.restore())

    expect({ outcome, sent: api.sent, signedIn: client.auth.getState().isAuthenticated }).toEqual({
      outcome: 'resolved',
      sent: [],
      signedIn: false,
    })
    expect(storages.local.get(HINT) ?? null).toBeNull()
  })

  // Kills: a dead session that keeps refreshing on every page (the hint never cleared), or a refused restore that
  // throws into the page's script.
  it('AC-6: a refresh the API refuses with its 401 or 403 envelope: restore resolves signed out, the hint is removed, and the next page load’s restore sends nothing', async () => {
    quiet()
    for (const answer of ['refused', 'forbidden'] as const) {
      const storages = stubStorages({ local: { [HINT]: '1' } })
      const api = fakeSessionApi()
      api.refresh = answer
      const outcome = await settledOf(made().auth.restore())
      const firstLoad = api.sent.length

      const nextPage = made()
      await nextPage.auth.restore()

      expect(outcome, answer).toBe('resolved')
      expect(storages.local.get(HINT) ?? null, answer).toBeNull()
      expect(api.sent.length, `${answer}: the next page load sent`).toBe(firstLoad)
      expect(nextPage.auth.getState().isAuthenticated, answer).toBe(false)
      endStubs()
    }
  })

  // Kills: a hint cleared on any error, so an API restart signs every shopper out for good.
  it('AC-6: a refresh lost in transport or answered 5xx: restore resolves signed out for this load and keeps the hint, so the next page load refreshes again', async () => {
    quiet()
    for (const answer of ['down', 'server-error'] as const) {
      const storages = stubStorages({ local: { [HINT]: '1' } })
      const api = fakeSessionApi()
      api.refresh = answer
      const client = made()
      const outcome = await settledOf(client.auth.restore())
      const signedIn = client.auth.getState().isAuthenticated

      api.refresh = 'works'
      const nextPage = made()
      await nextPage.auth.restore()

      expect({ outcome, signedIn }, answer).toEqual({ outcome: 'resolved', signedIn: false })
      expect(storages.local.get(HINT) ?? null, answer).toBe('1')
      expect(api.refreshes(), `${answer}: refreshes over both loads`).toBe(2)
      expect(nextPage.auth.getState().isAuthenticated, answer).toBe(true)
      endStubs()
    }
  })

  // Kills: a hint cleared on any failed refresh (an API restart signs every shopper out for good), or one kept after
  // the API refused the session (a dead session refreshing on every page load).
  it('AC-6: over any run of page loads, restore keeps refreshing through transport failures and 5xx and stops for good after the first 401 or 403 refusal', async () => {
    quiet()
    const answer = fc.constantFrom<RefreshAnswer>('works', 'refused', 'forbidden', 'server-error', 'down')
    await fc.assert(
      fc.asyncProperty(fc.array(answer, { minLength: 1, maxLength: 6 }), async (loads) => {
        const storages = stubStorages({ local: { [HINT]: '1' } })
        const api = fakeSessionApi()
        const refused = loads.findIndex((a) => a === 'refused' || a === 'forbidden')
        const reached = refused === -1 ? loads.length : refused + 1
        const signedIn: boolean[] = []
        try {
          for (const load of loads) {
            api.refresh = load
            const client = createNymbalClient({ baseUrl: BASE })
            await client.auth.restore()
            signedIn.push(client.auth.getState().isAuthenticated)
            client.destroy()
          }

          expect(api.refreshes(), `refreshes over ${loads.join(', ')}`).toBe(reached)
          expect(signedIn, `signed in over ${loads.join(', ')}`).toEqual(
            loads.map((a, i) => a === 'works' && i < reached),
          )
          expect(storages.local.get(HINT) ?? null, `hint after ${loads.join(', ')}`).toBe(
            refused === -1 ? '1' : null,
          )
        } finally {
          endStubs()
        }
      }),
      { numRuns: 60 },
    )
  })

  // Kills: a restore that refreshes when a token is already held (rotating the session on every call).
  it('AC-6: a token held: restore reads the profile with it and sends no refresh', async () => {
    stubStorages()
    const api = fakeSessionApi()
    const client = made()
    await client.auth.login(CUSTOMER.email, 'pw')
    const held = api.issued[0]

    await client.auth.restore()

    expect(api.refreshes()).toBe(0)
    expect(api.bearersTo('/api/customers/me')).toEqual([`Bearer ${held}`])
    expect(client.auth.getState().isAuthenticated).toBe(true)
  })

  // Kills: a browser whose storage throws (a locked-down or private window) breaking sign-in or the page's restore.
  it('AC-6: with a Web Storage that throws on every call, the client is made, login signs in and restore resolves', async () => {
    quiet()
    stubStorages({ throwing: true })
    const api = fakeSessionApi()
    const client = made()

    await client.auth.login(CUSTOMER.email, 'pw')
    const outcome = await settledOf(client.auth.restore())

    expect(outcome).toBe('resolved')
    expect(client.auth.getState().isAuthenticated).toBe(true)
    expect(api.refreshes()).toBe(0)
  })
})

describe('AC-6: the session hint follows sign-in, sign-out and refused refreshes', () => {
  // Kills: a hint that is never written (every reload signed out) or never removed (a signed-out browser refreshes on
  // every page).
  it('AC-6: SESSION_HINT_KEY is nymbal.auth.session from both entries; login and register set it to "1" and logout removes it', async () => {
    const storages = stubStorages()
    fakeSessionApi()
    const client = made()
    const hint = () => storages.local.get(HINT) ?? null
    const seen: Array<string | null> = [hint()]

    await client.auth.login(CUSTOMER.email, 'pw')
    seen.push(hint())
    await client.auth.logout()
    seen.push(hint())
    await client.auth.register({ email: CUSTOMER.email, password: 'pw' })
    seen.push(hint())
    await client.auth.logout()
    seen.push(hint())

    expect(seen).toEqual([null, '1', null, '1', null])
    expect([SESSION_HINT_KEY, CORE_HINT_KEY]).toEqual([HINT, HINT])
  })

  // Kills: the 401 path clearing the hint on a transport failure, or keeping it once the API refused the session.
  it('AC-6: the 401 path’s refresh: refused with the API’s 401 envelope removes the hint; lost in transport keeps it', async () => {
    quiet()
    const outcomes: Record<string, Array<string | null>> = {}
    for (const answer of ['refused', 'down'] satisfies RefreshAnswer[]) {
      const storages = stubStorages()
      const api = fakeSessionApi()
      const client = made()
      await client.auth.login(CUSTOMER.email, 'pw')
      const afterLogin = storages.local.get(HINT) ?? null
      api.lapse(api.issued[0]!)
      api.refresh = answer

      await settledOf(client.customer.addresses.list())

      outcomes[answer] = [afterLogin, storages.local.get(HINT) ?? null]
      expect(api.refreshes(), answer).toBe(1)
      endStubs()
    }

    expect(outcomes).toEqual({ refused: ['1', null], down: ['1', '1'] })
  })

  // Kills: the timer clearing the hint on a transport failure, or keeping it once the API refused the session.
  it('AC-6: the timer’s refresh at 80% of the access lifetime: refused with the API’s 401 envelope removes the hint; lost in transport keeps it', async () => {
    quiet()
    const outcomes: Record<string, Array<string | null>> = {}
    for (const answer of ['refused', 'down'] satisfies RefreshAnswer[]) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const storages = stubStorages()
      const api = fakeSessionApi()
      api.expiresIn = 10
      const client = made()
      await client.auth.login(CUSTOMER.email, 'pw')
      const afterLogin = storages.local.get(HINT) ?? null
      api.refresh = answer

      await vi.advanceTimersByTimeAsync(8_000)
      await settle()

      outcomes[answer] = [afterLogin, storages.local.get(HINT) ?? null]
      expect(api.sent.filter((s) => s.path === REFRESH).length, answer).toBe(1)
      client.destroy()
      vi.useRealTimers()
      endStubs()
    }

    expect(outcomes).toEqual({ refused: ['1', null], down: ['1', '1'] })
  })
})
