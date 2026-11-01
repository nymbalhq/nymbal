import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Cart, CartItem } from '@nymbalhq/types'
import {
  checkoutOf,
  createKernel,
  seedVariant,
  type Kernel,
  type Seeded,
} from '../../tests/support/kernel.js'
import { createCartService } from './cart-service.js'

// signIn(guestToken, customerId) on the cart service the kernel wires (its catalogue and the order lookup rule 5
// needs come from services/index.ts): which cart the customer has after a sign-in, for each shape of guest cart G and
// customer cart C.

const MAX_LINE_QTY = 99

let k: Kernel
let X: Seeded
let Y: Seeded
let Z: Seeded

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  X = await seedVariant(k, 500)
  Y = await seedVariant(k, 500)
  Z = await seedVariant(k, 500)
}, 60_000)

afterAll(async () => {
  await k?.close()
})

const newCustomer = (): string => `customer-${randomUUID()}`

/** A cart (a guest's when `customerId` is null) holding these lines, through the cart service. */
async function cartOf(
  customerId: string | null,
  lines: Array<[Seeded, number]>,
  productName = 'Transactional Widget',
): Promise<Cart> {
  const cart = await k.services.cart.getOrCreate(undefined, customerId)
  let held = cart
  for (const [seeded, qty] of lines) {
    held = await k.services.cart.addItem(cart.token, {
      variantId: seeded.variantId,
      productId: seeded.productId,
      productName,
      variantName: 'Default',
      priceMinor: seeded.priceMinor,
      imageUrl: '',
      qty,
    })
  }
  return held
}

const qtyOf = (cart: Cart | null, seeded: Seeded): number =>
  cart?.items.find((i) => i.variantId === seeded.variantId)?.qty ?? 0

const quantities = (cart: Cart | null): Array<[string, number]> =>
  (cart?.items ?? [])
    .map((i): [string, number] => [i.variantId, i.qty])
    .sort(([a], [b]) => a.localeCompare(b))

describe('signIn', () => {
  // Kills: no signIn; the max of the two quantities; the guest cart left readable after the merge.
  it("AC-7: G and C: the result is C's token holding each variant once at min(99, G + C), with the customer's id, and G is no longer readable", async () => {
    const customerId = newCustomer()
    const guest = await cartOf(null, [
      [X, 60],
      [Y, 1],
    ])
    const customer = await cartOf(customerId, [
      [X, 50],
      [Z, 2],
    ])

    const result = await k.services.cart.signIn(guest.token, customerId)

    expect(result?.token).toBe(customer.token)
    expect(result?.customerId).toBe(customerId)
    expect(quantities(result)).toEqual(
      [
        [X.variantId, Math.min(MAX_LINE_QTY, qtyOf(guest, X) + qtyOf(customer, X))],
        [Y.variantId, qtyOf(guest, Y) + qtyOf(customer, Y)],
        [Z.variantId, qtyOf(guest, Z) + qtyOf(customer, Z)],
      ].sort(([a], [b]) => String(a).localeCompare(String(b))),
    )
    expect(await k.services.cart.get(guest.token)).toBeNull()
    expect(await k.services.cart.get(customer.token)).toEqual(result)
  })

  // Kills: a guest cart that never gets its customer, so the next sign-in elsewhere cannot find it.
  it('AC-7: G only: the result is G under the same token, its lines unchanged, now carrying the customer’s id', async () => {
    const customerId = newCustomer()
    const guest = await cartOf(null, [
      [X, 2],
      [Y, 3],
    ])

    const result = await k.services.cart.signIn(guest.token, customerId)

    expect(result?.token).toBe(guest.token)
    expect(result?.customerId).toBe(customerId)
    expect(quantities(result)).toEqual(quantities(guest))
    expect((await k.services.cart.get(guest.token))?.customerId).toBe(customerId)
  })

  it('AC-7: C only: with no guest token, and with a token no live cart has, the result is C as it was', async () => {
    const customerId = newCustomer()
    const customer = await cartOf(customerId, [[Z, 4]])

    for (const guestToken of [undefined, `gone-${randomUUID()}`]) {
      const result = await k.services.cart.signIn(guestToken, customerId)
      expect(result?.token, String(guestToken)).toBe(customer.token)
      expect(quantities(result), String(guestToken)).toEqual(quantities(customer))
    }
  })

  it('AC-7: neither: a customer with no cart and no guest cart gets null', async () => {
    const customerId = newCustomer()
    const results = [
      await k.services.cart.signIn(undefined, customerId),
      await k.services.cart.signIn(`gone-${randomUUID()}`, customerId),
    ]
    expect(results).toEqual([null, null])
  })

  // Kills: customer A's cart folded into customer B's (or handed to B) because B's request carried its cookie.
  it("AC-7: a G owned by another customer is left as it was (lines and customerId), and the result is the signing-in customer's own C, or null when there is none", async () => {
    const owner = newCustomer()
    const theirs = await cartOf(owner, [
      [X, 2],
      [Y, 1],
    ])
    const withCart = newCustomer()
    const own = await cartOf(withCart, [[Z, 5]])
    const withoutCart = newCustomer()

    const toWithCart = await k.services.cart.signIn(theirs.token, withCart)
    const toWithoutCart = await k.services.cart.signIn(theirs.token, withoutCart)

    expect(toWithCart?.token).toBe(own.token)
    expect(quantities(toWithCart)).toEqual(quantities(own))
    expect(toWithoutCart).toBeNull()
    const after = await k.services.cart.get(theirs.token)
    expect(after?.customerId).toBe(owner)
    expect(quantities(after)).toEqual(quantities(theirs))
  })

  // Kills: a guest cart with a checkout in progress deleted into C, orphaning the checkout that is keyed by its token.
  it("AC-7: rule 5: a G with a pending order becomes the customer's cart under its own token, C's lines folded in by min(99, G + C) with G's fields for a shared variant, C no longer readable, and the pending order still found by G's token", async () => {
    const customerId = newCustomer()
    const started = await checkoutOf(k, X, 2)
    expect(started.orderStatus).toBe('pending')
    const guest = (await k.services.cart.get(started.cartToken))!
    const customer = await cartOf(
      customerId,
      [
        [X, 3],
        [Y, 1],
      ],
      'The customer’s copy',
    )

    const result = await k.services.cart.signIn(guest.token, customerId)

    expect(result?.token).toBe(guest.token)
    expect(result?.customerId).toBe(customerId)
    expect(quantities(result)).toEqual(
      [
        [X.variantId, Math.min(MAX_LINE_QTY, qtyOf(guest, X) + qtyOf(customer, X))],
        [Y.variantId, qtyOf(guest, Y) + qtyOf(customer, Y)],
      ].sort(([a], [b]) => String(a).localeCompare(String(b))),
    )
    const shared = result?.items.find((i: CartItem) => i.variantId === X.variantId)
    const guestLine = guest.items.find((i) => i.variantId === X.variantId)
    expect(shared?.productName).toBe(guestLine?.productName)
    expect(await k.services.cart.get(customer.token)).toBeNull()

    const pending = await k.store.read((tx) =>
      k.repos.order.findPendingByCartToken(tx, guest.token),
    )
    expect(pending?.id).toBe(started.orderId)
    expect(await k.services.cart.get(guest.token)).toEqual(result)
  })

  // Kills: a service composed without a catalogue failing at the first sign-in, and a variant whose product row is
  // gone read as sellable (or throwing) instead of dropped.
  it('a cart service composed without a catalogue drops, at sign-in, an inactive variant, a draft or archived product and a variant whose product is gone', async () => {
    const cart = createCartService({
      store: k.store,
      carts: k.repos.cart,
      publisher: k.publisher,
      logger: k.logger,
      currency: 'GBP',
    })
    const [kept, inactive, draft, archived, orphaned] = [
      await seedVariant(k, 10),
      await seedVariant(k, 10),
      await seedVariant(k, 10),
      await seedVariant(k, 10),
      await seedVariant(k, 10),
    ]
    const guest = await cart.getOrCreate()
    for (const seeded of [kept, inactive, draft, archived, orphaned]) {
      await cart.addItem(guest.token, {
        variantId: seeded.variantId,
        productId: seeded.productId,
        productName: 'Transactional Widget',
        variantName: 'Default',
        priceMinor: seeded.priceMinor,
        imageUrl: '',
        qty: 1,
      })
    }
    await k.store.transaction(async (tx) => {
      const at = new Date()
      await k.repos.variant.update(tx, inactive.variantId, { status: 'inactive', updatedAt: at })
      await k.repos.product.setStatus(tx, draft.productId, 'draft', at)
      await k.repos.product.setStatus(tx, archived.productId, 'archived', at)
      await k.repos.product.delete(tx, orphaned.productId)
    })
    const orphanVariant = await k.store.read((tx) =>
      k.repos.variant.findById(tx, orphaned.variantId),
    )
    expect(orphanVariant?.productId).toBe(orphaned.productId)

    const result = await cart.signIn(guest.token, newCustomer())

    expect(result?.token).toBe(guest.token)
    expect(quantities(result)).toEqual([[kept.variantId, 1]])
  })
})
