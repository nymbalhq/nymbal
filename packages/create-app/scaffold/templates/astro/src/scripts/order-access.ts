import { NymbalApiError } from '@nymbalhq/sdk'
import type { ShopperAddress, ShopperOrder } from '@nymbalhq/types'
import { client } from '../lib/client.js'
import { isPaid, orderHeading } from '../lib/order-status.js'
import { submitOnce } from '../lib/submit-once.js'

// The order page's two forms, each sent once per click from the browser. The expired key's email prompt reads the
// order with the email in a header and shows it on this page: read by the storefront's server instead, every shopper's
// tries would count against the API's per-address limit as one. "Send me my order link" asks the API, which answers
// the same whatever matched.

const byId = (id: string): HTMLElement | null => document.getElementById(id)

const field = (root: HTMLElement, name: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-order-field="${name}"]`)

/** The subtitle the server-rendered page gives the same status, its number under the same test id. */
function subtitle(order: ShopperOrder): Node[] {
  const number = document.createElement('strong')
  number.dataset.testid = 'order-number'
  number.textContent = order.orderNumber
  const text = (value: string) => document.createTextNode(value)
  if (isPaid(order.status)) {
    return [
      text('Thank you. Your order '),
      number,
      text(" is paid. We'll send a confirmation to the email you gave at checkout."),
    ]
  }
  if (order.status === 'pending') {
    return [
      text('Your order '),
      number,
      text(
        " is waiting for its payment. We'll email the address you gave at checkout once it arrives.",
      ),
    ]
  }
  return [text('Your order '), number, text(` is ${order.status.replace(/_/g, ' ')}.`)]
}

function addressLines(address: ShopperAddress): Node[] {
  const lines = [
    address.addressLine1,
    address.addressLine2,
    `${address.city}, ${address.region} ${address.postalCode}`,
    address.country,
  ].filter((line): line is string => typeof line === 'string' && line !== '')
  return lines.flatMap((line, i) => {
    const node = document.createTextNode(line)
    return i === 0 ? [node] : [document.createElement('br'), node]
  })
}

/** Fills the page's empty confirmation with the order, as the server renders a key's order. */
function fillOrder(view: HTMLElement, order: ShopperOrder): void {
  // The check mark is a flex box, which `hidden` does not hide: an unpaid order's is removed.
  if (!isPaid(order.status)) field(view, 'paid')?.remove()
  const heading = field(view, 'heading')
  if (heading) {
    heading.textContent = orderHeading(order.status)
    heading.dataset.testid = 'order-heading'
  }
  field(view, 'subtitle')?.replaceChildren(...subtitle(order))
  const number = field(view, 'number')
  if (number) number.textContent = order.orderNumber
  const status = field(view, 'status')
  if (status) {
    status.textContent = order.status
    status.dataset.testid = 'order-status'
  }
  view
    .querySelector('nymbal-order-timeline')
    ?.setAttribute('entries', JSON.stringify(order.timeline ?? []))
  const summary = view.querySelector('nymbal-order-summary')
  if (summary) {
    const items = (order.lineItems ?? []).map((item) => ({
      name: `${item.productName}${item.variantName ? ` - ${item.variantName}` : ''}`,
      qty: item.qty,
      unitPriceMinor: item.unitPriceMinor,
      lineTotalMinor: item.lineTotalMinor,
    }))
    summary.setAttribute('items', JSON.stringify(items))
    summary.setAttribute('subtotal-minor', String(order.subtotalMinor))
    summary.setAttribute('discount-minor', String(order.discountTotalMinor ?? 0))
    summary.setAttribute('shipping-minor', String(order.shippingTotalMinor ?? 0))
    summary.setAttribute('tax-minor', String(order.taxTotalMinor ?? 0))
    summary.setAttribute('total-minor', String(order.totalMinor))
    summary.setAttribute('currency', order.currency)
  }
  const shipping = field(view, 'shipping')
  if (shipping) {
    field(shipping, 'address')?.replaceChildren(...addressLines(order.shippingAddress))
    shipping.hidden = false
  }
}

/** Shows one of the expired page's three views: the prompt, the order, or the not-found state. */
function show(id: 'order-email-prompt' | 'order-opened' | 'order-not-found'): void {
  for (const view of ['order-email-prompt', 'order-opened', 'order-not-found']) {
    const el = byId(view)
    if (el) el.hidden = view !== id
  }
}

const prompt = document.getElementById('order-email-form') as HTMLFormElement | null
submitOnce(prompt, async () => {
  if (prompt === null) return
  const limited = prompt.querySelector<HTMLElement>('[data-testid="order-email-limited"]')
  const failed = byId('order-email-failed')
  if (limited) limited.hidden = true
  if (failed) failed.hidden = true
  const orderNumber = prompt.dataset.orderNumber ?? ''
  const key = new URLSearchParams(window.location.search).get('key') ?? ''
  const email = String(new FormData(prompt).get('email') ?? '').trim()

  let order: ShopperOrder
  try {
    order = await client.orders.get(orderNumber, { key, email })
  } catch (err) {
    // The answer an unknown number gets: the email did not open the order.
    if (err instanceof NymbalApiError && err.status === 404) return show('order-not-found')
    if (err instanceof NymbalApiError && err.status === 429) {
      if (limited) limited.hidden = false
      return
    }
    if (failed) failed.hidden = false
    throw err
  }
  const view = byId('order-opened')
  if (view === null) return
  fillOrder(view, order)
  show('order-opened')
})

const linkForm = document.getElementById('order-link-form') as HTMLFormElement | null
submitOnce(linkForm, async () => {
  if (linkForm === null) return
  const data = new FormData(linkForm)
  const failed = document.getElementById('order-link-failed')
  if (failed) failed.hidden = true
  try {
    await client.orders.requestLink({
      orderNumber: String(data.get('orderNumber') ?? '').trim(),
      email: String(data.get('email') ?? '').trim(),
    })
  } catch (err) {
    if (failed) failed.hidden = false
    throw err
  }
  linkForm.hidden = true
  const sent = document.querySelector<HTMLElement>('[data-testid="order-link-sent"]')
  if (sent) sent.hidden = false
})
