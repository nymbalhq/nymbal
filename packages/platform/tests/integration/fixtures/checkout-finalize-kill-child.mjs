// P1-04 fixture for AC-4: a real store (startTestStore, built kit and kernel) in a child process checks out two units
// of a variant at stock 3 from the cart `token` and finalises. The bus is armed (NYMBAL_CHAOS, set by runUntilKilled)
// only once beginCheckout is done, so the first bus publish from then on is the relay's drain after the finalize
// transaction commits: the process SIGKILLs itself there. The order id is written to `handoff` before finalize.
//
//   node checkout-finalize-kill-child.mjs <sqlite|postgres> <sqlite file | postgres url> <cart token> <handoff json>
import { writeFileSync } from 'node:fs'
import { startTestStore } from '../../../../proof-kit/dist/store.js'
import { armChaos } from '../../../../proof-kit/dist/chaos.js'

const [dialect, target, token, handoff] = process.argv.slice(2)
if ((dialect !== 'sqlite' && dialect !== 'postgres') || !target || !token || !handoff) {
  console.error(
    'usage: checkout-finalize-kill-child.mjs <sqlite|postgres> <sqlite file | postgres url> <cart token> <handoff json>',
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
const { services } = store.app

const product = await services.product.create({
  slug: 'convert-widget',
  name: 'Convert Widget',
  description: '',
  status: 'active',
  variants: [{ sku: 'CONVERT-1', name: 'Default', priceMinor: 1500, stock: 3, options: [] }],
})
const variant = product.variants[0]
const cart = await services.cart.getOrCreate(token)
await services.cart.addItem(cart.token, {
  variantId: variant.id,
  productId: product.id,
  productName: product.name,
  variantName: variant.name,
  priceMinor: variant.priceMinor,
  imageUrl: '',
  qty: 2,
})

const started = await services.checkout.beginCheckout({
  cartToken: cart.token,
  email: 'convert@p1-04.test',
  billingAddress: address,
  shippingAddress: address,
})
writeFileSync(
  handoff,
  JSON.stringify({ orderId: started.orderId, paymentIntentId: started.paymentIntent.id }),
)

armChaos(store.app.platform.eventBus)
await services.checkout.finalize(started.paymentIntent.id, {
  amountMinor: started.totalMinor,
  currency: started.currency,
})
console.log('finalize completed without a kill')
await store.stop()
