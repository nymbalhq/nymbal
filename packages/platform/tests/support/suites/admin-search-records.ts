import { randomUUID } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OrderLineItem, OrderSource, Role } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, type Dialect, type Kernel } from '../kernel.js'
import { adminClient, type AdminClient } from '../money.js'
import { unaudited } from '../write-audit.js'

// The admin global search over orders and customer accounts on one dialect, through the served kernel's route. Orders
// are written through the order repository with createdAt from a clock of the suite's own, so which orders are newer
// is set, not raced. The orders a test looks for among the oldest are written before a run of filler orders longer
// than a window of the newest orders, so a search over such a window cannot find them.

export interface AdminSearchRecordsOptions {
  /** A kernel on a database of its own. */
  open(): Promise<Kernel>
}

/** More newer orders than a window of the newest 100. */
const FILLER = 110

const line: OrderLineItem = {
  variantId: 'search-variant',
  productId: 'search-product',
  productName: 'Search Widget',
  variantName: 'Default',
  sku: 'SEARCH-1',
  qty: 1,
  unitPriceMinor: 1500,
  lineSubtotalMinor: 1500,
  lineTaxMinor: 0,
  lineTotalMinor: 1500,
  imageUrl: '',
}

interface Written {
  id: string
  orderNumber: string
  sequence: number
  createdAt: Date
}

interface FoundOrder {
  id: string
  orderNumber: string
}

interface FoundCustomer {
  id: string
  email: string
  passwordHash?: unknown
}

interface Answer {
  orders: FoundOrder[]
  customers: FoundCustomer[]
}

export function adminSearchRecordsSuite(
  dialect: Dialect,
  options: AdminSearchRecordsOptions,
): void {
  describe(`admin search over every order and customer (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let admin: AdminClient
    let clock = Date.parse('2026-06-01T09:00:00.000Z')

    const tag = randomUUID().slice(0, 8)
    const TAG = tag.toUpperCase()
    /** AC-1: found by part of its number and by part of its email. */
    let deepOrder: Written
    /** AC-5: an email with a non-ASCII letter. */
    let accentedOrder: Written
    /** AC-3: seven orders holding one term, all older than the filler. */
    const sevenOrders: Written[] = []

    async function writeOrder(
      orderNumber: string,
      email: string,
      opts: { source?: OrderSource; createdAt?: Date } = {},
    ): Promise<Written> {
      const id = uuidv7()
      const createdAt = opts.createdAt ?? new Date((clock += 1000))
      const sequence = await unaudited(() =>
        k.store.transaction(async (tx) => {
          const seq = await k.repos.orderSequence.nextSequence(tx)
          await k.repos.order.insert(tx, {
            id,
            orderNumber,
            sequence: seq,
            customerId: null,
            status: 'confirmed',
            email,
            billingAddress: address,
            shippingAddress: address,
            lineItems: [line],
            subtotalMinor: 1500,
            taxTotalMinor: 0,
            shippingTotalMinor: 0,
            discountTotalMinor: 0,
            totalMinor: 1500,
            currency: 'GBP',
            notes: '',
            metadata: {},
            paymentIntentId: null,
            ...(opts.source !== undefined && { source: opts.source }),
            createdAt,
            updatedAt: createdAt,
          })
          return seq
        }),
      )
      return { id, orderNumber, sequence, createdAt }
    }

    async function writeAccount(account: {
      id?: string
      email: string
      firstName?: string
      lastName?: string
      roles?: Role[]
      createdAt?: Date
    }): Promise<string> {
      const id = account.id ?? randomUUID()
      const createdAt = account.createdAt ?? new Date()
      await unaudited(() =>
        k.store.transaction((tx) =>
          k.repos.customer.insert(tx, {
            id,
            email: account.email,
            passwordHash: `$2a$04$stored-hash-${randomUUID()}`,
            firstName: account.firstName ?? '',
            lastName: account.lastName ?? '',
            ...(account.roles !== undefined && { roles: account.roles }),
            createdAt,
            updatedAt: createdAt,
          }),
        ),
      )
      return id
    }

    async function search(q: string): Promise<Answer> {
      const res = await admin.call<Answer>(
        'GET',
        `/api/admin/search?${new URLSearchParams({ q }).toString()}`,
      )
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      return res.body.data!
    }

    const idsOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id)
    const numbersOf = (rows: FoundOrder[]) => rows.map((r) => r.orderNumber)

    beforeAll(async () => {
      k = await options.open()
      served = await serveKernel(k)
      admin = await adminClient(k, served.baseUrl)
      deepOrder = await writeOrder(`DEEP-${TAG}-4417`, `wren-${tag}@orders.test`)
      accentedOrder = await writeOrder(`ACC-${TAG}`, `josé-${tag}@orders.test`)
      // Four of the seven share an instant across the fifth place, so which of them make the cut rests on the sequence.
      const shared = new Date((clock += 1000))
      for (let i = 0; i < 7; i += 1) {
        sevenOrders.push(
          await writeOrder(`SEVEN-${TAG}-${i}`, `heron-${tag}-${i}@orders.test`, {
            ...(i >= 3 && { createdAt: shared }),
          }),
        )
      }
      for (let i = 0; i < FILLER; i += 1) await writeOrder(`F-${i}`, `filler-${i}@orders.test`)
    }, 120_000)

    afterAll(async () => {
      await served?.stop()
    })

    it(`AC-1: an order with more than 100 newer orders is found by part of its order number and by part of its email in another case (${dialect})`, async () => {
      const byNumber = await search(`${tag}-441`)
      const byEmail = await search(`WREN-${TAG}@ORDERS`)

      expect(idsOf(byNumber.orders)).toEqual([deepOrder.id])
      expect(idsOf(byEmail.orders)).toEqual([deepOrder.id])
    }, 60_000)

    it(`AC-2: a customer who never ordered is found by part of their email, first name and last name in another case, and a staff account holding the term is not (${dialect})`, async () => {
      const customerId = await writeAccount({
        email: `ottoline-${tag}@shoppers.test`,
        firstName: `Marisol${tag}`,
        lastName: `Brackwater${tag}`,
      })
      await writeAccount({
        email: `ottoline-${tag}-staff@shoppers.test`,
        firstName: `Marisol${tag}`,
        lastName: `Brackwater${tag}`,
        roles: ['admin'],
      })

      const byEmail = await search(`OTTOLINE-${TAG}`)
      const byFirstName = await search(`mARISOL${TAG}`)
      const byLastName = await search(`BRACKWATER${TAG}`)

      expect(idsOf(byEmail.customers)).toEqual([customerId])
      expect(idsOf(byFirstName.customers)).toEqual([customerId])
      expect(idsOf(byLastName.customers)).toEqual([customerId])
    }, 60_000)

    it(`AC-3: with seven holding the term, orders are exactly the five newest and customers exactly the first five by createdAt then id, none carrying a passwordHash (${dialect})`, async () => {
      const base = Date.parse('2026-03-01T12:00:00.000Z')
      // Four accounts share an instant across the fifth place, so which of them make the cut rests on the id.
      const accounts: Array<{ id: string; createdAt: Date }> = []
      for (let i = 0; i < 7; i += 1) {
        const createdAt = new Date(base + Math.min(i, 3) * 60_000)
        const id = await writeAccount({ email: `ferncliff-${tag}-${i}@shoppers.test`, createdAt })
        accounts.push({ id, createdAt })
      }
      const firstFiveAccounts = [...accounts]
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
        .slice(0, 5)
        .map((a) => a.id)
      const fiveNewestOrders = [...sevenOrders]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.sequence - a.sequence)
        .slice(0, 5)
        .map((o) => o.id)

      const orders = (await search(`HERON-${TAG}`)).orders
      const customers = (await search(`FERNCLIFF-${TAG}`)).customers

      expect(idsOf(orders)).toEqual(fiveNewestOrders)
      expect(idsOf(customers)).toEqual(firstFiveAccounts)
      expect(customers.filter((c) => 'passwordHash' in c).map((c) => c.id)).toEqual([])
    }, 60_000)

    it(`AC-5: an order whose email holds a non-ASCII letter, with more than 100 newer orders, is found by that part of the email in the other case (${dialect})`, async () => {
      const found = await search(`JOSÉ-${TAG}`)

      expect(idsOf(found.orders)).toEqual([accentedOrder.id])
    }, 60_000)

    it(`AC-6: an order whose number equals the term comes first, then the newest of the rest, and a synthetic order with the exact number is not answered (${dialect})`, async () => {
      await writeOrder('P-7', `exact-one-${tag}@orders.test`)
      for (let n = 70; n <= 75; n += 1) await writeOrder(`P-${n}`, `exact-${n}-${tag}@orders.test`)
      await writeOrder('Z-9', `synthetic-${tag}@orders.test`, { source: 'synthetic' })
      for (let n = 90; n <= 95; n += 1) await writeOrder(`Z-${n}`, `later-${n}-${tag}@orders.test`)

      const exact = await search('p-7')
      const syntheticExact = await search('z-9')

      expect(numbersOf(exact.orders)).toEqual(['P-7', 'P-75', 'P-74', 'P-73', 'P-72'])
      expect(numbersOf(syntheticExact.orders)).toEqual(['Z-95', 'Z-94', 'Z-93', 'Z-92', 'Z-91'])
    }, 60_000)
  })
}
