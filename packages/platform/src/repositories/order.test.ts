import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'

// Removing an imported order deletes that order's row alone, and the store's own orders are found by the time they
// were placed: every order at or after an instant, the instant included.

async function setup() {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  return { store, repo: repos.order }
}
type Env = Awaited<ReturnType<typeof setup>>

let sequence = 0
async function order(env: Env, createdAt = new Date()): Promise<string> {
  const id = uuidv7()
  sequence += 1
  await env.store.transaction((tx) =>
    env.repo.insert(tx, {
      id,
      orderNumber: `OR-${sequence}-${id.slice(-6)}`,
      sequence,
      customerId: null,
      status: 'confirmed',
      email: 'o@example.com',
      billingAddress: {} as never,
      shippingAddress: {} as never,
      lineItems: [],
      subtotalMinor: 9000,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: 9000,
      currency: 'GBP',
      notes: '',
      metadata: {},
      paymentIntentId: null,
      createdAt,
      updatedAt: createdAt,
    }),
  )
  return id
}

const find = (env: Env, id: string) => env.store.read((tx) => env.repo.findById(tx, id))

describe('OrderRepository: removal and orders since a time', () => {
  // Defect: the delete loses its id condition (rolling one imported order back empties the orders table) or deletes
  // nothing (the removed order stays in the store).
  it('delete removes that order and leaves every other order as it was', async () => {
    const env = await setup()
    const [gone, kept, alsoKept] = [await order(env), await order(env), await order(env)]
    const keptBefore = [await find(env, kept), await find(env, alsoKept)]

    await env.store.transaction((tx) => env.repo.delete(tx, gone))

    expect(await find(env, gone)).toBeNull()
    expect([await find(env, kept), await find(env, alsoKept)]).toEqual(keptBefore)
    await env.store.close()
  })

  // Defect: the bound is strict or reversed (an order placed the instant the import ran, or one placed before it, is
  // counted the wrong way) or the filter is dropped (every order counts as the store's own).
  it('idsCreatedSince answers every order placed at or after the time and none before', async () => {
    const env = await setup()
    const base = Date.UTC(2026, 9, 1, 10, 0, 0)
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: -3, max: 3 }), { maxLength: 6 }),
        fc.integer({ min: -3, max: 3 }),
        async (offsets, sinceAt) => {
          // Fresh orders each run, so earlier runs' rows are told apart and a counterexample replays alone.
          const placed: { id: string; at: number }[] = []
          for (const at of offsets)
            placed.push({ id: await order(env, new Date(base + at * 1000)), at })
          const ids = placed.map((p) => p.id)
          const since = new Date(base + sinceAt * 1000)
          const got = await env.store.read((tx) => env.repo.idsCreatedSince(tx, since))
          const expected = placed.filter((p) => p.at >= sinceAt).map((p) => p.id)
          expect(got.filter((id) => ids.includes(id)).sort()).toEqual(expected.sort())
        },
      ),
      { numRuns: 20 },
    )
    await env.store.close()
  })
})

// ─── The admin list's filters, run in the query ─────────────────────────────────────────────────────────────────
// The repository's `list` and `count` against a reference over the orders each case writes: the reference applies the
// filter's predicates in the test, so a wildcard left live, a bound compared as text, a postcode compared with its
// spaces or a country compared by case each answer a different set from it.

type ListFilter = NonNullable<Parameters<Env['repo']['count']>[1]>

interface Placed {
  id: string
  orderNumber: string
  sequence: number
  status: 'pending' | 'confirmed' | 'cancelled'
  email: string
  customerId: string | null
  createdAt: Date
  postalCode: string | undefined
  country: string | undefined
}

interface PlaceSpec {
  status?: Placed['status']
  email?: string
  customerId?: string | null
  createdAt?: Date
  sequence?: number
  number?: string
  ship?: { postalCode?: string; country?: string }
  bill?: { postalCode?: string; country?: string }
}

const AT = new Date('2026-11-01T09:00:00.000Z')

/** Writes one order; a key left out of `ship` or `bill` is left out of that address's JSON. */
async function place(env: Env, spec: PlaceSpec = {}): Promise<Placed> {
  const id = uuidv7()
  sequence += 1
  const seq = spec.sequence ?? sequence
  const ship = spec.ship ?? {}
  const p: Placed = {
    id,
    orderNumber: spec.number ?? `OR-${seq}-${id.slice(-6)}`,
    sequence: seq,
    status: spec.status ?? 'confirmed',
    email: spec.email ?? 'o@example.com',
    customerId: spec.customerId ?? null,
    createdAt: spec.createdAt ?? AT,
    postalCode: ship.postalCode,
    country: ship.country,
  }
  await env.store.transaction((tx) =>
    env.repo.insert(tx, {
      id,
      orderNumber: p.orderNumber,
      sequence: p.sequence,
      customerId: p.customerId,
      status: p.status,
      email: p.email,
      billingAddress: { ...(spec.bill ?? {}) } as never,
      shippingAddress: { ...ship } as never,
      lineItems: [],
      subtotalMinor: 9000,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: 9000,
      currency: 'GBP',
      notes: '',
      metadata: {},
      paymentIntentId: null,
      createdAt: p.createdAt,
      updatedAt: p.createdAt,
    }),
  )
  return p
}

const squeezed = (text: string): string => text.toUpperCase().replaceAll(' ', '')
const holds = (value: string | null, part: string): boolean =>
  (value ?? '').toLowerCase().includes(part.toLowerCase())

/** The filter's predicates over what the case wrote. */
function admits(o: Placed, f: ListFilter): boolean {
  if (f.status !== undefined && o.status !== f.status) return false
  if (f.from !== undefined && o.createdAt.getTime() < new Date(f.from).getTime()) return false
  if (f.to !== undefined && o.createdAt.getTime() > new Date(f.to).getTime()) return false
  if (f.customer !== undefined && !holds(o.customerId, f.customer) && !holds(o.email, f.customer))
    return false
  if (f.q !== undefined && !holds(o.orderNumber, f.q) && !holds(o.email, f.q)) return false
  if (f.postcode !== undefined) {
    if (o.postalCode === undefined || o.postalCode === '') return false
    if (!squeezed(o.postalCode).startsWith(squeezed(f.postcode))) return false
  }
  if (f.country !== undefined) {
    if (o.country === undefined || o.country === '') return false
    if (o.country.toUpperCase() !== f.country.toUpperCase()) return false
  }
  return true
}

/** Every written order the filter admits, createdAt descending, then sequence descending. */
const reference = (all: readonly Placed[], f: ListFilter): string[] =>
  all
    .filter((o) => admits(o, f))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.sequence - a.sequence)
    .map((o) => o.id)

async function listed(env: Env, f: ListFilter, page: { limit?: number; offset?: number } = {}) {
  const orders = await env.store.read((tx) => env.repo.list(tx, { ...f, ...page }))
  return orders.map((o) => o.id)
}
const counted = (env: Env, f: ListFilter) => env.store.read((tx) => env.repo.count(tx, f))

/** list (unpaged) and count both answer the reference for this filter. */
async function expectReference(env: Env, all: readonly Placed[], f: ListFilter): Promise<void> {
  const want = reference(all, f)
  expect({ f, ids: await listed(env, f, { limit: 1000 }) }).toEqual({ f, ids: want })
  expect({ f, n: await counted(env, f) }).toEqual({ f, n: want.length })
}

describe('OrderRepository: the admin list filters and count', () => {
  // Defect: a filter key is ignored or inverted, a wildcard in customer or q is live, a bound is compared as text, a
  // page is sliced before ordering, or count counts something other than the list it pages.
  it('AC-1: property: list equals the reference filtered, ordered and sliced, and count equals its length', async () => {
    const DAYS = ['2026-10-31', '2026-11-01', '2026-11-02'] as const
    const TIMES = ['00:00:00.000', '07:00:00.000', '09:00:00.000', '09:00:00.123', '23:59:59.999']
    const text = (chars: string[], min: number, max: number) =>
      fc.string({ unit: fc.constantFrom(...chars), minLength: min, maxLength: max })
    const WILD = ['%', '_', '\\']
    const POST = ['S', 'w', '1', 'A', ' ', '\t', ...WILD]
    const maybe = <T>(arb: fc.Arbitrary<T>) =>
      fc.oneof(fc.constant(undefined), fc.constant(''), arb, arb, arb)
    const draft = fc.record({
      status: fc.constantFrom('pending', 'confirmed', 'cancelled' as const),
      createdAt: fc
        .tuple(fc.constantFrom(...DAYS), fc.constantFrom(...TIMES))
        .map(([d, t]) => new Date(`${d}T${t}Z`)),
      email: text(['a', 'B', '.', ...WILD], 1, 5).map((l) => `${l}@S.test`),
      customerId: fc.option(text(['c', 'U', '1', ...WILD], 1, 5), { nil: null }),
      postalCode: maybe(text(POST, 1, 6)),
      country: maybe(fc.constantFrom('GB', 'gb', 'DE', 'us')),
    })
    const bound = fc
      .tuple(fc.constantFrom(...DAYS), fc.constantFrom('date', 'secZ', 'msZ', 'plus', 'minus'))
      .map(([d, form]) =>
        form === 'date'
          ? d
          : form === 'secZ'
            ? `${d}T09:00:00Z`
            : form === 'msZ'
              ? `${d}T09:00:00.123Z`
              : form === 'plus'
                ? `${d}T09:00:00+02:00`
                : `${d}T07:00:00-02:00`,
      )
    const part = text(['a', 'B', 'c', 'U', '1', '@', 'S', ...WILD], 1, 3)
    const filter = fc.record(
      {
        status: fc.constantFrom('pending', 'confirmed', 'cancelled' as const),
        from: bound,
        to: bound,
        customer: part,
        q: part,
        postcode: text(POST, 1, 3).filter((p) => p.replaceAll(' ', '') !== ''),
        country: fc.constantFrom('GB', 'gb', 'de', 'FR'),
      },
      { requiredKeys: [] },
    )
    const page = fc.record({
      limit: fc.integer({ min: 1, max: 8 }),
      offset: fc.integer({ min: 0, max: 10 }),
    })
    await fc.assert(
      fc.asyncProperty(
        fc.array(draft, { minLength: 1, maxLength: 12 }),
        filter,
        page,
        async (drafts, f, pg) => {
          const env = await setup()
          const all: Placed[] = []
          for (const d of drafts) {
            const ship: { postalCode?: string; country?: string } = {}
            if (d.postalCode !== undefined) ship.postalCode = d.postalCode
            if (d.country !== undefined) ship.country = d.country
            all.push(
              await place(env, { ...d, ship, bill: { postalCode: 'SW1A 1AA', country: 'GB' } }),
            )
          }
          const want = reference(all, f)
          expect(await listed(env, f, pg)).toEqual(want.slice(pg.offset, pg.offset + pg.limit))
          expect(await counted(env, f)).toBe(want.length)
          await env.store.close()
        },
      ),
      { numRuns: 60 },
    )
  })

  // Defect: a bound is compared as text against the stored toISOString() value, so a seconds-only bound misses the
  // order at that second, an offset bound is read as UTC, and a date-only bound is not the start of that UTC day.
  it('AC-1: from and to admit the orders at or between the instants they name, in every form the route admits', async () => {
    const env = await setup()
    const all = [
      '2026-10-31T23:59:59.999Z',
      '2026-11-01T00:00:00.000Z',
      '2026-11-01T07:00:00.000Z',
      '2026-11-01T08:59:59.999Z',
      '2026-11-01T09:00:00.000Z',
      '2026-11-01T09:00:00.001Z',
      '2026-11-01T09:00:00.123Z',
      '2026-11-01T09:00:00.124Z',
      '2026-11-02T00:00:00.000Z',
    ]
    const placed: Placed[] = []
    for (const at of all) placed.push(await place(env, { createdAt: new Date(at) }))
    const BOUNDS = [
      '2026-11-01',
      '2026-11-02',
      '2026-11-01T09:00:00Z',
      '2026-11-01T09:00:00.123Z',
      '2026-11-01T11:00:00+02:00',
      '2026-11-01T07:00:00-02:00',
      '2026-11-01T09:00:00.000+00:00',
    ]
    for (const b of BOUNDS) {
      await expectReference(env, placed, { from: b })
      await expectReference(env, placed, { to: b })
      for (const c of BOUNDS) await expectReference(env, placed, { from: b, to: c })
    }
    // The bound's own instant is inside both ends.
    expect(
      await listed(env, { from: '2026-11-01T09:00:00Z', to: '2026-11-01T11:00:00+02:00' }),
    ).toEqual([placed[4]!.id])
    await env.store.close()
  })

  // Defect: customer or q is a LIKE with its needle unescaped (`%` matches every order, `_` any one character), is
  // case-sensitive, reads the wrong column, or does not read a missing customerId as empty.
  it('AC-1: customer and q hold their text literally, case-insensitive, and read only their columns', async () => {
    const env = await setup()
    const placed = [
      await place(env, { email: 'a%b@shop.test', customerId: 'cust_ONE', number: 'NB-100' }),
      await place(env, { email: 'axb@shop.test', customerId: 'custXone', number: 'NB-1x0' }),
      await place(env, { email: 'a_b@shop.test', customerId: null, number: 'NB-%00' }),
      await place(env, { email: 'a\\b@Shop.Test', customerId: 'c\\1', number: 'NB-_00' }),
      await place(env, { email: 'plain@other.test', customerId: '50%off', number: 'NB-200' }),
    ]
    const NEEDLES = [
      '%',
      '_',
      '\\',
      'A%B',
      'a_B',
      'cust_one',
      'CUSTXONE',
      'SHOP.TEST',
      '50%',
      'nb-1',
      'x',
      'nb-%',
      'nb-_',
      'missing',
      '',
    ]
    for (const n of NEEDLES) {
      await expectReference(env, placed, { customer: n })
      await expectReference(env, placed, { q: n })
    }
    expect(await listed(env, { customer: '%' })).toEqual(
      expect.arrayContaining([placed[0]!.id, placed[4]!.id]),
    )
    expect(await counted(env, { customer: '%' })).toBe(2)
    expect(await counted(env, { q: '_' })).toBe(2)
    await env.store.close()
  })

  // Defect: the postcode keeps its spaces, is case-sensitive, reads the billing address, removes a tab as if it were a
  // space, treats % or _ as wildcards, or lets a missing or empty shipping postcode match an argument of spaces.
  it('AC-3: postcode is a literal prefix of the shipping postcode, case and U+0020 ignored, missing matching nothing', async () => {
    const env = await setup()
    const placed = [
      await place(env, { ship: { postalCode: 'SW1A 1AA' } }),
      await place(env, { ship: { postalCode: 'sw1v3lp' } }),
      await place(env, { ship: { postalCode: 'SW10 9AB' } }),
      await place(env, { ship: { postalCode: 'E1 6AN' } }),
      await place(env, { ship: { postalCode: 'E1 6AN' }, bill: { postalCode: 'SW1A 1AA' } }),
      await place(env, { ship: { postalCode: 'S W\t1' } }),
      await place(env, { ship: { postalCode: '%1 2AB' } }),
      await place(env, { ship: { postalCode: 'S_1 \\9' } }),
      await place(env, { ship: { postalCode: '' } }),
      await place(env, { ship: {}, bill: { postalCode: 'SW1' } }),
    ]
    const ARGS = [
      'sw1',
      'SW 1',
      ' s w 1 a ',
      'SW10',
      'E1 6',
      'SW\t',
      'S W\t',
      '%',
      '_',
      'S_',
      'S_1\\',
      'SX1',
      ' ',
      'sw1a1aa',
      'sw1a1aab',
    ]
    for (const a of ARGS) await expectReference(env, placed, { postcode: a })
    expect(await listed(env, { postcode: 'sw1' })).toEqual(
      expect.arrayContaining([placed[0]!.id, placed[1]!.id, placed[2]!.id]),
    )
    expect(await counted(env, { postcode: 'sw1' })).toBe(3)
    // The orders it answers read back with their own shipping address, parsed.
    const got = await env.store.read((tx) => env.repo.list(tx, { postcode: 'sw1' }))
    expect(got.map((o) => o.shippingAddress.postalCode)).toEqual(
      reference(placed, { postcode: 'sw1' }).map(
        (id) => placed.find((p) => p.id === id)!.postalCode,
      ),
    )
    expect(await counted(env, { postcode: '%' })).toBe(1)
    // A blank argument admits every order with a shipping postcode, and still none without one.
    expect(await counted(env, { postcode: ' ' })).toBe(placed.length - 2)
    await env.store.close()
  })

  // Defect: country is case-sensitive, reads the billing address, or a missing or empty shipping country matches.
  it('AC-3: country equals the shipping country case-insensitively, and a missing or empty one matches nothing', async () => {
    const env = await setup()
    const placed = [
      await place(env, { ship: { country: 'GB' } }),
      await place(env, { ship: { country: 'gb' } }),
      await place(env, { ship: { country: 'Gb' }, bill: { country: 'DE' } }),
      await place(env, { ship: { country: 'DE' }, bill: { country: 'GB' } }),
      await place(env, { ship: { country: '' } }),
      await place(env, { ship: {}, bill: { country: 'GB' } }),
      await place(env, { ship: { country: 'GBR' } }),
    ]
    for (const c of ['GB', 'gb', 'gB', 'DE', 'de', 'US', 'G', '', '%', '_B'])
      await expectReference(env, placed, { country: c })
    expect(await counted(env, { country: 'gb' })).toBe(3)
    expect(await counted(env, { country: '' })).toBe(0)
    await env.store.close()
  })

  // Defect: the status key is ignored or read as some other status, or filters combine with OR.
  it('AC-1: status narrows to that status, and keys combine as AND', async () => {
    const env = await setup()
    const placed = [
      await place(env, { status: 'confirmed', ship: { country: 'GB' } }),
      await place(env, { status: 'pending', ship: { country: 'GB' } }),
      await place(env, { status: 'confirmed', ship: { country: 'DE' } }),
      await place(env, { status: 'cancelled', ship: { country: 'GB' } }),
    ]
    for (const status of ['confirmed', 'pending', 'cancelled'] as const) {
      await expectReference(env, placed, { status })
      await expectReference(env, placed, { status, country: 'GB' })
    }
    await expectReference(env, placed, {})
    expect(await counted(env, { status: 'confirmed', country: 'gb' })).toBe(1)
    await env.store.close()
  })

  // Defect: orders placed at the same instant are not ordered by sequence (or ascending), so a paged walk repeats or
  // skips one; offset or limit is ignored; count counts the page.
  it('AC-2: ties go by sequence descending, a walk by limit and offset visits each order once, and count is the whole set', async () => {
    const env = await setup()
    const later = new Date(AT.getTime() + 1000)
    const placed: Placed[] = []
    for (const [s, at] of [
      [902, AT],
      [905, AT],
      [901, later],
      [904, AT],
      [903, AT],
      [900, later],
    ] as const)
      placed.push(await place(env, { sequence: s, createdAt: at }))
    const want = reference(placed, {})
    expect(await listed(env, {})).toEqual(want)
    expect(want.map((id) => placed.find((p) => p.id === id)!.sequence)).toEqual([
      901, 900, 905, 904, 903, 902,
    ])
    for (const limit of [1, 2, 4]) {
      const walked: string[] = []
      for (let offset = 0; offset < placed.length + limit; offset += limit)
        walked.push(...(await listed(env, {}, { limit, offset })))
      expect(walked).toEqual(want)
    }
    expect(await listed(env, {}, { limit: 2, offset: 5 })).toEqual(want.slice(5))
    expect(await counted(env, {})).toBe(want.length)
    expect(await env.store.read((tx) => env.repo.count(tx))).toBe(want.length)
    await env.store.close()
  })
})
