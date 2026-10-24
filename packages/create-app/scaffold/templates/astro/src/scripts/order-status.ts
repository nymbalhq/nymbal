import { client } from '../lib/client.js'

// A pending order's page asks the API again for a while: once the payment lands (a Stripe webhook), the page is
// rendered afresh with the order's new state.
const POLL_EVERY_MS = 1_000
const POLL_FOR_MS = 10_000

const root = document.querySelector<HTMLElement>('[data-order-number][data-order-status]')
const orderNumber = root?.dataset.orderNumber
const shown = root?.dataset.orderStatus

if (orderNumber && shown === 'pending') {
  const until = Date.now() + POLL_FOR_MS
  const poll = async (): Promise<void> => {
    try {
      const order = await client.customer.orders.get(orderNumber)
      if (order.status !== shown) {
        window.location.reload()
        return
      }
    } catch {
      // A failed read is asked again on the next tick, within the window.
    }
    if (Date.now() < until) setTimeout(poll, POLL_EVERY_MS)
  }
  setTimeout(poll, POLL_EVERY_MS)
}
