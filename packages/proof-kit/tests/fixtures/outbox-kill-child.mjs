// P1-03 fixture for AC-1 and AC-2: a real store (startTestStore, built kit and kernel) in a child process, its bus
// armed by armChaos from NYMBAL_CHAOS, runs one checkout (beginCheckout) for the buyer, which the stub pays inline
// (P1-12 decision 1): no finalize call of its own. Armed at order.paid.v1 it SIGKILLs when the relay hands that event
// to the bus: after the payment's transaction committed, before the email handler saw it. Unarmed, it completes and
// exits 0.
//
//   node outbox-kill-child.mjs <sqlite|postgres> <sqlite file | postgres url> <buyer email>
import { armChaos } from '@nymbalhq/proof-kit/chaos'
import { startTestStore } from '@nymbalhq/proof-kit/store'

const [dialect, target, email] = process.argv.slice(2)
if ((dialect !== 'sqlite' && dialect !== 'postgres') || !target || !email) {
  console.error(
    'usage: outbox-kill-child.mjs <sqlite|postgres> <sqlite file | postgres url> <buyer email>',
  )
  process.exit(64)
}

const address = {
  firstName: 'Ada',
  lastName: 'Buyer',
  addressLine1: '1 Main St',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

const store = await startTestStore(
  dialect === 'postgres'
    ? { commandStore: 'postgres', postgresUrl: target }
    : { sqlitePath: target },
)
const { services, platform } = store.app
armChaos(platform.eventBus)

const product = await services.product.create({
  slug: 'outbox-widget',
  name: 'Outbox Widget',
  description: '',
  status: 'active',
  variants: [{ sku: 'OUTBOX-1', name: 'Default', priceMinor: 1500, stock: 3, options: [] }],
})
const variant = product.variants[0]
const cart = await services.cart.getOrCreate()
await services.cart.addItem(cart.token, {
  variantId: variant.id,
  productId: product.id,
  productName: product.name,
  variantName: variant.name,
  priceMinor: variant.priceMinor,
  imageUrl: '',
  qty: 1,
})
await services.checkout.beginCheckout({
  cartToken: cart.token,
  email,
  billingAddress: address,
  shippingAddress: address,
})
console.log('checkout completed without a kill')
await store.stop()
