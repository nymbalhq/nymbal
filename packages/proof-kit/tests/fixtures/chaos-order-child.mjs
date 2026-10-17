// P1-01 chaos fixture (AC-9): a real store in a child process, its kernel bus armed by armChaos from the
// environment (NYMBAL_CHAOS), places one order. A subscriber appends every delivered event type to a marker file.
//
//   node chaos-order-child.mjs <sqlite file> <marker file> <buyer email>
import { appendFileSync } from 'node:fs'
import { armChaos } from '@nymbalhq/proof-kit/chaos'
import { startTestStore } from '@nymbalhq/proof-kit/store'

const [sqlitePath, markerPath, email] = process.argv.slice(2)
if (!sqlitePath || !markerPath || !email) {
  console.error('usage: chaos-order-child.mjs <sqlite file> <marker file> <buyer email>')
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

const store = await startTestStore({ sqlitePath })
const { services, platform } = store.app
await platform.eventBus.subscribe('*', (event) => {
  appendFileSync(markerPath, `${event.type}\n`)
})
armChaos(platform.eventBus)

const product = await services.product.create({
  slug: 'chaos-widget',
  name: 'Chaos Widget',
  description: '',
  status: 'active',
  variants: [{ sku: 'CHAOS-1', name: 'Default', priceMinor: 1500, stock: 3, options: [] }],
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
