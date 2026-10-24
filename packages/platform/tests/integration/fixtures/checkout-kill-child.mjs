// A real store (startTestStore, built kit and kernel) in a child process runs one beginCheckout of one unit from a
// variant at stock 3. In `kill` mode the process SIGKILLs itself from inside the checkout transaction, after the order
// insert (the wrapped orderHistory.append runs the real append first, then dies), before any commit. In `control`
// mode it completes and exits 0.
//
//   node checkout-kill-child.mjs <sqlite|postgres> <sqlite file | postgres url> <kill|control>
import { startTestStore } from '../../../../proof-kit/dist/store.js'

const [dialect, target, mode] = process.argv.slice(2)
if (
  (dialect !== 'sqlite' && dialect !== 'postgres') ||
  !target ||
  (mode !== 'kill' && mode !== 'control')
) {
  console.error(
    'usage: checkout-kill-child.mjs <sqlite|postgres> <sqlite file | postgres url> <kill|control>',
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
const { services, repos } = store.app

const product = await services.product.create({
  slug: 'kill-widget',
  name: 'Kill Widget',
  description: '',
  status: 'active',
  variants: [{ sku: 'KILL-1', name: 'Default', priceMinor: 1500, stock: 3, options: [] }],
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

if (mode === 'kill') {
  const append = repos.orderHistory.append.bind(repos.orderHistory)
  repos.orderHistory.append = async (...args) => {
    await append(...args)
    process.kill(process.pid, 'SIGKILL')
    return new Promise(() => {})
  }
}

await services.checkout.beginCheckout({
  cartToken: cart.token,
  // `+stub-pending`: the control's footprint is the checkout's own, with no inline payment.
  email: 'kill+stub-pending@txn.test',
  billingAddress: address,
  shippingAddress: address,
})
console.log('checkout completed without a kill')
await store.stop()
