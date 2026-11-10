import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { serveKernel } from '../support/http.js'
import { createKernel } from '../support/kernel.js'
import { shopper } from '../support/shopper.js'
import { openVerificationStore, type Policy } from '../support/verification.js'

// GET /api/capabilities tells the storefront the sign-up policy the server applies: `off` for the kernel's `native`
// email (it only logs), `required` with an adapter that delivers, and the configured value over either. What it says
// is what a register over HTTP then does: 202 "check your email" exactly where it says `required`, 201 signed in
// where it says `off`.

interface Store {
  baseUrl: string
  stop(): Promise<void>
}

const stores: Store[] = []

afterAll(async () => {
  for (const store of stores.splice(0)) await store.stop()
}, 60_000)

function withPolicy(verification: Policy | undefined) {
  return (config: NymbalConfig): NymbalConfig =>
    verification === undefined
      ? config
      : ({
          ...config,
          security: { ...config.security, auth: { ...config.security.auth, verification } },
        } as NymbalConfig)
}

/** The kernel's own `native` email, with the policy set or not. */
async function nativeStore(verification: Policy | undefined): Promise<Store> {
  const k = await createKernel({ dialect: 'sqlite', configure: withPolicy(verification) })
  const served = await serveKernel(k)
  const store = { baseUrl: served.baseUrl, stop: () => served.stop() }
  stores.push(store)
  return store
}

/** A store whose email adapter is the tests' own capture, which delivers, with the policy set or not. */
async function deliveringStore(verification: Policy | undefined): Promise<Store> {
  const s = await openVerificationStore(
    (opts) => createKernel({ dialect: 'sqlite', ...opts }),
    verification === undefined ? {} : { verification },
  )
  const store = { baseUrl: s.base, stop: () => s.close() }
  stores.push(store)
  return store
}

/** What the store reports, and what a register of a new address over HTTP answers there. */
async function observe(store: Store): Promise<{ reported: unknown; registerStatus: number }> {
  const shop = shopper(store.baseUrl)
  const caps = await shop.call<{ auth?: { verification?: unknown } }>('GET', '/api/capabilities')
  expect(caps.status).toBe(200)
  const registered = await shop.call('POST', '/api/auth/register', {
    email: `caps-${randomUUID().slice(0, 8)}@verify.test`,
    password: 'caps-correct-horse',
  })
  return { reported: caps.body.data?.auth?.verification, registerStatus: registered.status }
}

describe('AC-1: GET /api/capabilities reports the sign-up policy the server applies', () => {
  const cases: Array<{ name: string; open: () => Promise<Store>; expected: Policy }> = [
    {
      name: 'the kernel’s native email, policy unset',
      open: () => nativeStore(undefined),
      expected: 'off',
    },
    {
      name: 'a delivering adapter, policy unset',
      open: () => deliveringStore(undefined),
      expected: 'required',
    },
    {
      name: 'native email, policy required',
      open: () => nativeStore('required'),
      expected: 'required',
    },
    {
      name: 'a delivering adapter, policy off',
      open: () => deliveringStore('off'),
      expected: 'off',
    },
  ]

  for (const c of cases) {
    // Defect: a native store asks for a link that only reaches the log; a store with mail stays enumerable by default;
    // or the storefront is told a different policy than the server applies.
    it(`AC-1: ${c.name}: auth.verification reads ${c.expected}, and a register answers 202 exactly when it reads required`, async () => {
      const store = await c.open()

      const { reported, registerStatus } = await observe(store)

      expect(reported).toBe(c.expected)
      expect(registerStatus).toBe(reported === 'required' ? 202 : 201)
    }, 60_000)
  }
})
