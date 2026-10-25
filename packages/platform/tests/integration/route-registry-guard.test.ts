import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { routeSchemas } from '../../src/routes/schemas.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { primedShopper } from '../support/security.js'

// AC-1 and AC-15 as properties over the schema registry, against a served kernel (SQLite). AC-1: every
// state-changing route but the Stripe webhook refuses a request without a CSRF pair with 403, before auth (admin
// routes answer 403, not 401) and before anything is written. AC-15: every route with a body schema answers a body
// it rejects with 400 `validation.failed`, never 500. And every signed-in customer route refuses a request with no
// token, so a customer route registered without its auth guard is caught.

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
/** Registered with `csrf: false`; its body schema is `z.unknown()` and its own signature check answers bad input. */
const STRIPE_WEBHOOK = 'POST /api/webhooks/stripe'
/** What a route may answer to a body its schema accepts: the handler ran, or auth or a missing resource stopped it. */
const ACCEPTED = [200, 201, 202, 204, 401, 403, 404]

function split(key: string): { method: string; path: string } {
  const at = key.indexOf(' ')
  return { method: key.slice(0, at), path: key.slice(at + 1) }
}

/** Every `:param` replaced with `id`. */
function fill(path: string, id: string): string {
  return path.replace(/:[A-Za-z_]\w*/g, encodeURIComponent(id))
}

const unsafeKeys = Object.keys(routeSchemas).filter(
  (key) => UNSAFE.has(split(key).method) && key !== STRIPE_WEBHOOK,
)
const bodyKeys = Object.entries(routeSchemas)
  .filter(([key, schema]) => schema.body !== undefined && key !== STRIPE_WEBHOOK)
  .map(([key]) => key)
const customerKeys = Object.keys(routeSchemas).filter((key) =>
  split(key).path.startsWith('/api/customers/me'),
)
/** Each customer route is sent the first of these its body schema accepts, so only the auth guard can stop it. */
const CANDIDATE_BODIES: unknown[] = [
  {},
  {
    firstName: 'Ada',
    lastName: 'Lovelace',
    addressLine1: '1 Analytical Way',
    city: 'London',
    region: 'LDN',
    postalCode: 'N1 1AA',
    country: 'GB',
  },
]

describe('the guard and the parser over every registered route', () => {
  let k: Kernel
  let served: ServedKernel
  let raw: RawReader

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(k)
    raw = openRaw(k.dialect, k.target)
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  it('AC-1: every POST/PUT/PATCH/DELETE route but the Stripe webhook answers 403 csrf.invalid to a request with no CSRF cookie or header, admin routes included, and writes nothing', async () => {
    expect(unsafeKeys).toContain('POST /api/cart/items')
    expect(unsafeKeys.filter((key) => key.includes(' /api/admin/')).length).toBeGreaterThan(0)
    const cartsBefore = await raw.count('carts')
    const eventsBefore = await raw.count('events')

    for (const key of unsafeKeys) {
      const { method, path } = split(key)
      await fc.assert(
        fc.asyncProperty(fc.uuid(), async (id) => {
          const res = await fetch(new URL(fill(path, id), served.baseUrl), {
            method,
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: '{}',
          })
          const body = (await res.json()) as { error?: { code: string } }
          expect(res.status, `${key} → ${res.status} ${JSON.stringify(body)}`).toBe(403)
          expect(body.error?.code, key).toBe('csrf.invalid')
        }),
        { numRuns: 2 },
      )
    }

    expect(await raw.count('carts')).toBe(cartsBefore)
    expect(await raw.count('events')).toBe(eventsBefore)
  })

  it('AC-15: every route with a body schema answers a body its schema rejects with 400 validation.failed and a non-empty issues list, a body it accepts with 2xx/401/403/404, and never 500', async () => {
    expect(bodyKeys).toContain('POST /api/cart/items')
    const shop = await primedShopper(served.baseUrl)

    for (const key of bodyKeys) {
      const { method, path } = split(key)
      const schema = routeSchemas[key]!.body!
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom<unknown>({ __invalid: true }, [], 'x', 42),
          fc.uuid(),
          async (body, id) => {
            const res = await shop.call(method, fill(path, id), body)
            const seen = `${key} with ${JSON.stringify(body)} → ${res.status} ${JSON.stringify(res.body)}`
            expect(res.status, seen).toBeLessThan(500)
            const accepted = schema.safeParse(body).success
            const issues =
              (res.body.error as { context?: { issues?: unknown[] } } | undefined)?.context
                ?.issues ?? []
            expect(accepted ? ACCEPTED : [400], seen).toContain(res.status)
            // A rejected body is reported as validation.failed with its issues, an accepted one never is.
            expect(res.body.error?.code === 'validation.failed' && issues.length > 0, seen).toBe(
              !accepted,
            )
          },
        ),
        { numRuns: 4 },
      )
    }
  })

  it('every /api/customers/me* route answers 401 auth.unauthorized to a request with a CSRF pair and no token: the set of 401 routes equals the registered customer routes', async () => {
    expect(customerKeys).toContain('GET /api/customers/me')
    const shop = await primedShopper(served.baseUrl)
    const refused: string[] = []
    const seen: string[] = []

    for (const key of customerKeys) {
      const { method, path } = split(key)
      const schema = routeSchemas[key]!.body
      const body = schema && CANDIDATE_BODIES.find((candidate) => schema.safeParse(candidate).success)
      if (schema !== undefined && body === undefined) {
        throw new Error(`${key}: no candidate body its schema accepts; add one to CANDIDATE_BODIES`)
      }
      const res = await shop.call(method, fill(path, crypto.randomUUID()), body)
      seen.push(`${key} → ${res.status} ${res.body.error?.code ?? ''}`)
      if (res.status === 401 && res.body.error?.code === 'auth.unauthorized') refused.push(key)
    }

    expect(refused.sort(), seen.join('\n')).toEqual(customerKeys.toSorted())
  })
})
