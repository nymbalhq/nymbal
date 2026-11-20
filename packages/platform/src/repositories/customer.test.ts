import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore, type CommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories, type Repositories } from './index.js'
import type { CustomerRepository } from './customer.js'

// A sign-up under `required` is stored `pending` and becomes `verified` once confirmed; every other account leaves the
// column null (never asked). The mail-health funnel counts, among accounts created in [since, until), those asked to
// confirm and those that did; the admin read carries the state so the customer page can offer support its buttons.

const DAY_MS = 24 * 60 * 60_000
const SINCE = Date.parse('2026-11-01T00:00:00.000Z')
const UNTIL = SINCE + 7 * DAY_MS

type State = 'never-asked' | 'pending' | 'verified'

let store: CommandStore
let repos: Repositories
let repo: CustomerRepository

beforeAll(async () => {
  store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  repo = repos.customer
})

afterAll(async () => {
  await store?.close()
})

/** Writes an account as a sign-up leaves it: inserted pending (or not asked), then confirmed by an update. */
async function account(state: State, createdAt: Date): Promise<string> {
  const id = uuidv7()
  await store.transaction(async (tx) => {
    await repo.insert(tx, {
      id,
      email: `${id}@test.com`,
      passwordHash: 'hash',
      ...(state !== 'never-asked' && { emailVerification: 'pending' as const }),
      createdAt,
      updatedAt: createdAt,
    })
    if (state === 'verified') {
      await repo.update(tx, id, { emailVerification: 'verified', updatedAt: createdAt })
    }
  })
  return id
}

/** Offsets from the window's start, with both of its edges and the millisecond either side drawn often. */
const offsetMs = fc.oneof(
  fc.constantFrom(-1, 0, 1, UNTIL - SINCE - 1, UNTIL - SINCE, UNTIL - SINCE + 1),
  fc.integer({ min: -3 * DAY_MS, max: 10 * DAY_MS }),
)
const state = fc.constantFrom<State>('never-asked', 'pending', 'verified')

describe('customer repository: email verification', () => {
  it('AC-13: property: the funnel counts the accounts created in [since, until) that were asked to confirm, and of those the confirmed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ offset: offsetMs, state }), { maxLength: 12 }),
        async (accounts) => {
          const ids: string[] = []
          try {
            for (const a of accounts) ids.push(await account(a.state, new Date(SINCE + a.offset)))
            const inWindow = accounts.filter((a) => a.offset >= 0 && SINCE + a.offset < UNTIL)
            const funnel = await store.read((tx) =>
              repo.verificationFunnel(tx, new Date(SINCE), new Date(UNTIL)),
            )
            expect(funnel).toEqual({
              started: inWindow.filter((a) => a.state !== 'never-asked').length,
              verified: inWindow.filter((a) => a.state === 'verified').length,
            })
          } finally {
            await store.transaction(async (tx) => {
              for (const id of ids) await repo.delete(tx, id)
            })
          }
          // A deleted account is counted nowhere, so the next run starts from an empty table.
          expect(
            await store.read((tx) =>
              repo.verificationFunnel(tx, new Date(SINCE - DAY_MS), new Date(UNTIL + DAY_MS)),
            ),
          ).toEqual({ started: 0, verified: 0 })
        },
      ),
      { numRuns: 60 },
    )
  })

  it('AC-24: every read of an account carries the state its sign-up left, and a never-asked account carries none', async () => {
    const at = new Date(SINCE)
    const written = {
      'never-asked': await account('never-asked', at),
      pending: await account('pending', at),
      verified: await account('verified', at),
    }
    try {
      for (const [state, id] of Object.entries(written)) {
        const expected = state === 'never-asked' ? undefined : state
        const [byId, byEmail, listed] = await store.read(async (tx) => [
          await repo.findById(tx, id),
          await repo.findByEmail(tx, `${id.toUpperCase()}@TEST.COM`),
          (await repo.list(tx)).find((c) => c.id === id),
        ])
        for (const read of [byId, byEmail, listed]) {
          expect(read?.id).toBe(id)
          expect(read?.emailVerification).toBe(expected)
          expect(Object.hasOwn(read!, 'emailVerification')).toBe(expected !== undefined)
        }
      }
    } finally {
      await store.transaction(async (tx) => {
        for (const id of Object.values(written)) await repo.delete(tx, id)
      })
    }
  })
})

// An account is due for removal as never confirmed while it is pending, was last written before `before`, has no order,
// and has no verification or reset link still open at `now` (expires_at > now). The list pages the due ids in id
// order; the conditional delete re-checks the same predicate, so it removes the row only while it is still due.

type Verification = null | 'pending' | 'verified'

interface Shape {
  verification: Verification
  /** Milliseconds from `before` to the last write. */
  updated: number
  orders: number
  /** Milliseconds from `now` to each verification link's and each reset link's expiry. */
  links: number[]
  resets: number[]
}

const isDue = (a: Shape) =>
  a.verification === 'pending' &&
  a.updated < 0 &&
  a.orders === 0 &&
  [...a.links, ...a.resets].every((o) => o <= 0)

const address = {
  firstName: 'Ada',
  lastName: 'Buyer',
  addressLine1: '1 Main St',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

// Each window sits 400 days before the last, so an account written for an earlier window was last written after this
// window's cut-off and is never due in it. Every account is made 100 days before its cut-off: only its last write keeps it.
const ORIGIN = Date.UTC(2001, 0, 1)
let windows = 0
function nextWindow(): { before: Date; now: Date } {
  windows += 1
  const before = new Date(ORIGIN - windows * 400 * DAY_MS)
  return { before, now: new Date(before.getTime() + 30 * DAY_MS) }
}

async function shaped(a: Shape, w: { before: Date; now: Date }): Promise<string> {
  const id = uuidv7()
  const updatedAt = new Date(w.before.getTime() + a.updated)
  await store.transaction(async (tx) => {
    await repo.insert(tx, {
      id,
      email: `${id}@due.test`,
      passwordHash: 'hash',
      ...(a.verification !== null && { emailVerification: 'pending' as const }),
      createdAt: new Date(w.before.getTime() - 100 * DAY_MS),
      updatedAt,
    })
    if (a.verification === 'verified') {
      await repo.update(tx, id, { emailVerification: 'verified', updatedAt })
    }
    for (const [tokens, offsets] of [
      [repos.emailVerificationToken, a.links],
      [repos.passwordResetToken, a.resets],
    ] as const) {
      for (const o of offsets) {
        await tokens.insert(tx, {
          id: uuidv7(),
          customerId: id,
          tokenHash: uuidv7(),
          expiresAt: new Date(w.now.getTime() + o),
          createdAt: w.before,
        })
      }
    }
    for (let i = 0; i < a.orders; i += 1) {
      const orderId = uuidv7()
      await repos.order.insert(tx, {
        id: orderId,
        orderNumber: `DUE-${orderId}`,
        sequence: await repos.orderSequence.nextSequence(tx),
        customerId: id,
        status: 'pending',
        email: `${id}@due.test`,
        billingAddress: address,
        shippingAddress: address,
        lineItems: [],
        subtotalMinor: 1200,
        taxTotalMinor: 0,
        shippingTotalMinor: 0,
        discountTotalMinor: 0,
        totalMinor: 1200,
        currency: 'GBP',
        createdAt: w.before,
        updatedAt: w.before,
      })
    }
  })
  return id
}

async function listAll(w: { before: Date; now: Date }, limit: number, bound: number) {
  const pages: string[][] = []
  let after: string | undefined
  // Bounded, so a list that ignores `after` repeats into the assertion instead of looping.
  for (let page = 0; page <= bound; page += 1) {
    const ids = await store.read((tx) =>
      repo.listUnconfirmed(tx, { ...w, ...(after !== undefined && { after }), limit }),
    )
    pages.push(ids)
    if (ids.length < limit) break
    after = ids.at(-1)
  }
  return pages
}

const DUE: Shape = { verification: 'pending', updated: -1, orders: 0, links: [], resets: [] }

describe('customer repository: never-confirmed accounts', () => {
  // Defect: one guard of the predicate is dropped or off by one (`<=` for `<` on updated_at, `>=` for `>` on a link's
  // expiry, a link compared with an empty or wrong `now`), so an account it should keep is listed and deleted.
  it('each guard alone keeps an otherwise due account out of the list and the delete, and the due one beside it goes', async () => {
    const w = nextWindow()
    const kept: Record<string, Shape> = {
      'never asked': { ...DUE, verification: null },
      verified: { ...DUE, verification: 'verified' },
      'written at before': { ...DUE, updated: 0 },
      'written after before': { ...DUE, updated: 1 },
      'an order': { ...DUE, orders: 1 },
      'a link open past now': { ...DUE, links: [1] },
      'a reset open past now': { ...DUE, resets: [1] },
      'an expired link beside an open one': { ...DUE, links: [-1, 1] },
    }
    const due: Record<string, Shape> = {
      'no link': DUE,
      'written long before': { ...DUE, updated: -DAY_MS },
      'a link expiring at now': { ...DUE, links: [0] },
      'a reset expired before now': { ...DUE, resets: [-1] },
    }
    const keptIds = new Map<string, string>()
    for (const [name, a] of Object.entries(kept)) keptIds.set(name, await shaped(a, w))
    const dueIds = new Map<string, string>()
    for (const [name, a] of Object.entries(due)) dueIds.set(name, await shaped(a, w))

    const listed = (await listAll(w, 100, 1)).flat()
    expect(listed).toEqual([...dueIds.values()].sort())

    const answers = new Map<string, boolean>()
    for (const [name, id] of [...keptIds, ...dueIds]) {
      answers.set(name, await store.transaction((tx) => repo.deleteUnconfirmed(tx, id, w)))
    }
    const remaining = new Map<string, boolean>()
    for (const [name, id] of [...keptIds, ...dueIds]) {
      remaining.set(name, (await store.read((tx) => repo.findById(tx, id)))?.id === id)
    }
    for (const name of keptIds.keys()) {
      expect({ name, deleted: answers.get(name), remains: remaining.get(name) }).toEqual({
        name,
        deleted: false,
        remains: true,
      })
    }
    for (const name of dueIds.keys()) {
      expect({ name, deleted: answers.get(name), remains: remaining.get(name) }).toEqual({
        name,
        deleted: true,
        remains: false,
      })
    }
    // Once gone, a due account answers false: the delete reports a row that went, not one that was due.
    const [first] = dueIds.values()
    expect(await store.transaction((tx) => repo.deleteUnconfirmed(tx, first!, w))).toBe(false)
  })

  // Defect: a page ignores `after` (repeats), uses `>=` (repeats the boundary id), drops the order or the limit, or the
  // delete answers by the predicate rather than by the row it removed.
  it('property: paged by any limit, the list answers each due id once, ascending, and the delete answers true exactly for those and removes only them', async () => {
    const offset = fc.constantFrom(-1, 0, 1)
    const shape: fc.Arbitrary<Shape> = fc.record({
      verification: fc.constantFrom<Verification>(null, 'pending', 'verified'),
      updated: offset,
      orders: fc.integer({ min: 0, max: 1 }),
      links: fc.array(offset, { maxLength: 2 }),
      resets: fc.array(offset, { maxLength: 2 }),
    })
    // Due accounts drawn often, so most runs page across several of them.
    const account = fc.oneof(shape, fc.constant(DUE), fc.constant(DUE))
    await fc.assert(
      fc.asyncProperty(
        fc.array(account, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 1, max: 4 }),
        async (accounts, limit) => {
          const w = nextWindow()
          const written: Array<{ id: string; due: boolean }> = []
          for (const a of accounts) written.push({ id: await shaped(a, w), due: isDue(a) })
          const due = written
            .filter((a) => a.due)
            .map((a) => a.id)
            .sort()

          const pages = await listAll(w, limit, written.length + 1)
          for (const page of pages) expect(page.length).toBeLessThanOrEqual(limit)
          expect(pages.flat()).toEqual(due)

          const answers: boolean[] = []
          for (const a of written) {
            answers.push(await store.transaction((tx) => repo.deleteUnconfirmed(tx, a.id, w)))
          }
          const remains: boolean[] = []
          for (const a of written) {
            remains.push((await store.read((tx) => repo.findById(tx, a.id)))?.id === a.id)
          }
          expect(answers).toEqual(written.map((a) => a.due))
          expect(remains).toEqual(written.map((a) => !a.due))
          expect(await store.read((tx) => repo.listUnconfirmed(tx, { ...w, limit: 100 }))).toEqual(
            [],
          )
        },
      ),
      { numRuns: 40 },
    )
  })
})
