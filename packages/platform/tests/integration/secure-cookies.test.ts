import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { createNativeStubPaymentsAdapter } from '../../src/adapters/payments/native-stub.js'
import { createLogger } from '../../src/logger.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant } from '../support/kernel.js'
import { shopper, type ShopResponse } from '../support/shopper.js'

// Every cookie the API sets carries `Secure` exactly when the store's public origin is https: NYMBAL_PUBLIC_URL when
// it is set, else `store.url`. With neither, `Secure` follows NODE_ENV=production. Over NODE_ENV {unset, staging,
// production} and four origins, the refresh cookie (register, login, refresh, and the logout cookie that clears it),
// the cart cookie, the recently-viewed visitor cookie and the CSRF cookie are each read from the response that sets
// them.

type NodeEnv = undefined | 'staging' | 'production'

interface Origin {
  label: string
  publicUrl?: string
  storeUrl?: string
  https: boolean | null
}

const ORIGINS: Origin[] = [
  // NYMBAL_PUBLIC_URL wins over a store.url that says otherwise.
  {
    label: 'NYMBAL_PUBLIC_URL https',
    publicUrl: 'https://shop.example',
    storeUrl: 'http://localhost:4321',
    https: true,
  },
  { label: 'store.url https only', storeUrl: 'https://shop.example', https: true },
  { label: 'store.url http://localhost:4321', storeUrl: 'http://localhost:4321', https: false },
  { label: 'no origin', https: null },
]

const PUBLIC_URL = 'NYMBAL_PUBLIC_URL'
const PASSWORD = 'correct-horse-battery'
const saved = { NODE_ENV: process.env.NODE_ENV, [PUBLIC_URL]: process.env[PUBLIC_URL] }
const open: ServedKernel[] = []

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(async () => {
  for (const s of open.splice(0)) await s.stop()
  for (const [key, value] of Object.entries(saved)) setEnv(key, value)
})

/**
 * A store production accepts at the origin's store.url: a secret of its own, and a `custom` payments slot holding an
 * adapter that is not the stub (the stub's behaviour under another name), so no payments package is resolved.
 */
function shaped(origin: Origin) {
  return (config: NymbalConfig): NymbalConfig => ({
    ...config,
    store: { ...config.store, ...(origin.storeUrl !== undefined && { url: origin.storeUrl }) },
    security: {
      ...config.security,
      auth: { ...config.security.auth, jwtSecret: 'secure-cookie-suite-secret-0123456789' },
    },
    commerce: { ...config.commerce, payments: { provider: 'custom' } },
  })
}

function ownPayments() {
  return {
    ...createNativeStubPaymentsAdapter({ logger: createLogger({ pretty: false, level: 'error' }) }),
    providerName: 'cookie-suite-payments',
  }
}

/** Whether the named cookie in a response is `Secure`, or `missing` when the response sets no such cookie. */
function secureOf(res: ShopResponse<unknown>, name: string): boolean | 'missing' {
  const header = res.setCookies.find((c) => c.split(';')[0]!.split('=')[0]!.trim() === name)
  if (header === undefined) return 'missing'
  return header
    .split(';')
    .slice(1)
    .some((attr) => attr.trim().toLowerCase() === 'secure')
}

const STEPS = [
  'GET /api/csrf nymbal.csrf',
  'POST /api/cart/items nymbal.cart',
  'POST /api/recently-viewed nymbal.visitor',
  'POST /api/auth/register nymbal.refresh',
  'POST /api/auth/login nymbal.refresh',
  'POST /api/auth/refresh nymbal.refresh',
  'POST /api/auth/logout nymbal.refresh',
] as const

/** Each step's cookie as one browser meets them, on a store served under `nodeEnv` and `origin`. */
async function cookiesUnder(nodeEnv: NodeEnv, origin: Origin): Promise<Array<boolean | 'missing'>> {
  setEnv('NODE_ENV', nodeEnv)
  setEnv(PUBLIC_URL, origin.publicUrl)
  const s = await serveKernel(
    await createKernel({
      dialect: 'sqlite',
      configure: shaped(origin),
      appOptions: { adapters: { payments: ownPayments() } },
    }),
  )
  open.push(s)
  const { productId, variantId } = await seedVariant(s.kernel, 5)
  const shop = shopper(s.baseUrl)
  const email = `cookie-${randomUUID()}@secure.test`

  const csrf = await shop.call('GET', '/api/csrf')
  const cart = await shop.call('POST', '/api/cart/items', { variantId, qty: 1 })
  const viewed = await shop.call('POST', '/api/recently-viewed', { productId })
  const register = await shop.call('POST', '/api/auth/register', { email, password: PASSWORD })
  const login = await shop.call('POST', '/api/auth/login', { email, password: PASSWORD })
  const refresh = await shop.call('POST', '/api/auth/refresh')
  const logout = await shop.call('POST', '/api/auth/logout')

  return [
    secureOf(csrf, 'nymbal.csrf'),
    secureOf(cart, 'nymbal.cart'),
    secureOf(viewed, 'nymbal.visitor'),
    secureOf(register, 'nymbal.refresh'),
    secureOf(login, 'nymbal.refresh'),
    secureOf(refresh, 'nymbal.refresh'),
    secureOf(logout, 'nymbal.refresh'),
  ]
}

/** Each origin's cookies as served under `nodeEnv`: per step, whether its cookie was Secure. */
async function served(nodeEnv: NodeEnv) {
  const observed = []
  for (const origin of ORIGINS) {
    const flags = await cookiesUnder(nodeEnv, origin)
    observed.push({ origin: origin.label, cookies: STEPS.map((step, i) => [step, flags[i]]) })
  }
  return observed
}

/** The rule: Secure iff the public origin is https; with no origin, iff production. */
function rule(nodeEnv: NodeEnv) {
  return ORIGINS.map((origin) => ({
    origin: origin.label,
    cookies: STEPS.map((step) => [step, origin.https ?? nodeEnv === 'production']),
  }))
}

describe('AC-11: cookies are Secure exactly when the public origin is https', () => {
  for (const nodeEnv of [undefined, 'staging', 'production'] as const) {
    it(`AC-11: under NODE_ENV ${nodeEnv ?? 'unset'}, every cookie the API sets is Secure iff the public origin is https, and with no origin iff production`, async () => {
      const observed = await served(nodeEnv)

      expect(observed).toEqual(rule(nodeEnv))
    }, 120_000)
  }
})
