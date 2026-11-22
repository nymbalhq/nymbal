import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfigInput } from './schema.js'

// The `heartbeat` block: `features.heartbeat` turns it on, and then the store check's address and email are required
// and a card is both ids or neither. `card.amountMinor` is a positive integer, 100 when unset. With the feature off the
// block may be empty.

const ADDRESS = {
  firstName: 'Heartbeat',
  lastName: 'Check',
  addressLine1: '9 Monitor Row',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

function config(
  heartbeat: unknown,
  on: boolean,
  store: Record<string, unknown> = {},
): NymbalConfigInput {
  return {
    store: {
      name: 'Test',
      currency: 'GBP',
      locale: 'en-GB',
      timezone: 'Europe/London',
      ...store,
    },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware', rateLimit: {}, csrf: true },
    commerce: {
      payments: { provider: 'native' },
      email: { provider: 'native' },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3001, host: '0.0.0.0' },
    deployment: { strategy: 'standard' },
    features: { heartbeat: on },
    ...(heartbeat !== undefined && { heartbeat }),
  } as NymbalConfigInput
}

/** The issue paths a refusal names, joined with dots; [] when the config parses. */
function refusedAt(heartbeat: unknown, on = true, store: Record<string, unknown> = {}): string[] {
  const result = nymbalConfigSchema.safeParse(config(heartbeat, on, store))
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'))
}

/** The parsed heartbeat block. */
function parsed(heartbeat: unknown, on = true) {
  const result = nymbalConfigSchema.safeParse(config(heartbeat, on))
  if (!result.success) throw new Error(JSON.stringify(result.error.issues))
  const block = (
    result.data as unknown as {
      heartbeat?: { card: Record<string, unknown>; store: Record<string, unknown> }
    }
  ).heartbeat
  if (block === undefined) throw new Error('the parsed config has no heartbeat block')
  return block
}

const STORE = { email: 'heartbeat@shop.example', address: ADDRESS }

describe('AC-15: the heartbeat block', () => {
  // Kills: a heartbeat that cannot run (no address, no email, half a card) accepted at load.
  it('AC-15: with features.heartbeat true, a missing store email, a missing store address (even with store.shipFrom set) and a card with one id are each refused naming the path', () => {
    expect(refusedAt({ store: { address: ADDRESS } })).toContain('heartbeat.store.email')
    expect(refusedAt({ store: { email: STORE.email } }, true, { shipFrom: ADDRESS })).toContain(
      'heartbeat.store.address',
    )
    expect(refusedAt({})).toEqual(
      expect.arrayContaining(['heartbeat.store.email', 'heartbeat.store.address']),
    )
    const onlyCustomer = refusedAt({ store: STORE, card: { customer: 'cus_123' } })
    const onlyMethod = refusedAt({ store: STORE, card: { paymentMethod: 'pm_123' } })
    expect(onlyCustomer.filter((p) => /^heartbeat\.card(\.paymentMethod)?$/.test(p))).toHaveLength(
      1,
    )
    expect(onlyMethod.filter((p) => /^heartbeat\.card(\.customer)?$/.test(p))).toHaveLength(1)
  })

  // Kills: amountMinor accepting zero or a fraction (a charge the provider refuses every run), or no default.
  it('AC-15: property: card.amountMinor keeps any positive integer given, is 100 when unset, and refuses 0 and 1.5 at its path', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000 }), (amountMinor) => {
        expect(parsed({ store: STORE, card: { amountMinor } }).card['amountMinor']).toBe(
          amountMinor,
        )
      }),
    )
    expect(parsed({ store: STORE }).card['amountMinor']).toBe(100)
    expect(refusedAt({ store: STORE, card: { amountMinor: 0 } })).toEqual([
      'heartbeat.card.amountMinor',
    ])
    expect(refusedAt({ store: STORE, card: { amountMinor: 1.5 } })).toEqual([
      'heartbeat.card.amountMinor',
    ])
  })

  // Kills: the required fields enforced with the feature off, so every store without a heartbeat fails to load; or a
  // valid block reshaped on the way in.
  it('AC-15: property: a full block parses as given with the feature on; with it off an empty block, or none, parses', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{1,10}(\+[a-z0-9]{1,5})?@[a-z]{2,8}\.(com|test|example)$/),
        fc.option(fc.stringMatching(/^[A-Z0-9-]{1,12}$/), { nil: undefined }),
        fc.option(
          fc.tuple(
            fc.stringMatching(/^cus_[a-zA-Z0-9]{4,10}$/),
            fc.stringMatching(/^pm_[a-zA-Z0-9]{4,10}$/),
          ),
          { nil: undefined },
        ),
        (email, sku, card) => {
          const block = {
            store: { email, address: ADDRESS, ...(sku !== undefined && { sku }) },
            ...(card !== undefined && { card: { customer: card[0], paymentMethod: card[1] } }),
          }
          const read = parsed(block)
          expect(read.store).toEqual(block.store)
          expect([read.card['customer'], read.card['paymentMethod']]).toEqual(card ?? [undefined, undefined])
        },
      ),
    )
    expect(refusedAt({}, false)).toEqual([])
    expect(refusedAt(undefined, false)).toEqual([])
    expect(parsed({}, false).card['amountMinor']).toBe(100)
  })
})
