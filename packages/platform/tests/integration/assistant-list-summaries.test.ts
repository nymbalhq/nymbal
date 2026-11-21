import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Address } from '@nymbalhq/types'
import { runAsActor } from '../../src/audit/actor.js'
import {
  ask,
  assistantStore,
  parsed,
  runTurn,
  toolTurns,
  viewsOf,
  type AssistantStore,
} from '../support/assistant.js'
import { cartWith, seedVariant } from '../support/kernel.js'

// AC-9: a default page of the orders list reaches the model whole. On a served SQLite store under the default config
// (the default mask, the default result size), 50 orders placed through checkout (24-character emails, names of up to
// 12 characters, London postcodes; unpaid, paid and partly refunded), and a scripted model that asks for
// admin_orders_list { limit: '50' }: the request after the call holds every order's number, the store's total and no
// note of items cut.

const FIRST = ['Christabelle', 'Maximiliano', 'Ana', 'Bartholomew', 'Evangeline'] as const
const LAST = ['Fitzwilliam', 'Abernathy', 'Okafor', 'Vanderbilt', 'Montgomeries'] as const
const POSTCODES = [
  'SW1A 1AA',
  'E1 6AN',
  'N1 9GU',
  'SE1 7PB',
  'W1D 3QF',
  'EC1A 1BB',
  'NW1 6XE',
  'WC2N 5DU',
]

/** An email of exactly 24 characters; `+stub-pending` leaves the order unpaid on the native payments stub. */
const emailOf = (i: number): string =>
  i % 3 === 0
    ? `p${String(i).padStart(3, '0')}+stub-pending@s.test`
    : `buyer-${String(i).padStart(4, '0')}@shoppers.test`

const shippingOf = (i: number): Address => ({
  firstName: FIRST[i % FIRST.length]!,
  lastName: LAST[(i * 3) % LAST.length]!,
  addressLine1: `${i + 1} Kensington Park Gardens`,
  city: 'London',
  region: 'Greater London',
  postalCode: POSTCODES[i % POSTCODES.length]!,
  country: 'GB',
  phone: `+44 20 7946 0${String(i).padStart(3, '0')}`,
})

let store: AssistantStore
const placed: string[] = []

beforeAll(async () => {
  store = await assistantStore()
  const k = store.kernel
  const seeded = await seedVariant(k, 1_000, { priceMinor: 2_499 })
  const paid: string[] = []
  for (let i = 0; i < 50; i += 1) {
    const order = await k.services.checkout.beginCheckout({
      cartToken: await cartWith(k, seeded, 1 + (i % 3)),
      email: emailOf(i),
      billingAddress: shippingOf(i),
      shippingAddress: shippingOf(i),
    })
    placed.push(order.orderNumber)
    if (i % 3 !== 0) paid.push(order.orderId)
  }
  await k.app.relay.drain()
  // Every fifth paid order partly refunded, and every fifth another one moved on: a refund leaves the status alone.
  for (const orderId of paid.filter((_, j) => j % 5 === 0)) {
    await runAsActor({ kind: 'admin', id: store.admin.userId }, () =>
      k.services.refund.refund({
        orderId,
        amountMinor: 500,
        reason: 'A scuffed box',
        actor: 'system:test',
      }),
    )
  }
  for (const orderId of paid.filter((_, j) => j % 5 === 1)) {
    await runAsActor({ kind: 'admin', id: store.admin.userId }, () =>
      k.services.order.updateStatus(orderId, 'processing', 'system:test'),
    )
  }
  await k.app.relay.drain()
}, 120_000)

afterAll(async () => {
  await store?.close()
})

describe('AC-9: a page of 50 orders reaches the model whole', () => {
  it("AC-9: on a store with 50 orders placed through checkout (24-character emails, names of up to 12 characters, London postcodes, mixed statuses), under the default config, the request after admin_orders_list { limit: '50' } holds all 50 order numbers, total 50 and no cut key", async () => {
    const statuses = await store.raw.rows<{ status: string }>('SELECT DISTINCT status FROM orders')
    store.standIn.script = (view) =>
      view.turns.at(-1)?.role === 'user'
        ? { toolCalls: [{ name: 'admin_orders_list', args: { limit: '50' } }] }
        : { text: 'Done.' }

    await runTurn(store, ask('List the orders.'))

    const after = viewsOf(store.standIn)[1]
    const turns = after === undefined ? [] : toolTurns(after)
    const listed = turns.length === 1 ? parsed(turns[0]!) : {}
    const numbers = ((listed['items'] as Array<Record<string, unknown>> | undefined) ?? []).map(
      (o) => String(o['orderNumber']),
    )

    expect(statuses.length).toBeGreaterThanOrEqual(3)
    expect(new Set(placed).size).toBe(50)
    expect([...numbers].sort()).toEqual([...placed].sort())
    expect(listed['total']).toBe(placed.length)
    expect(Object.keys(listed).filter((key) => key === 'cut')).toEqual([])
  }, 60_000)
})
