// What every figure in a report counts, stated so a model reading it cannot misstate it, and the rules for a rate.

export const DEFINITIONS = {
  currency:
    'The currency of the row. Every money figure is in minor units of it, and no figure sums or converts across currencies.',
  capturedMinor:
    "Money captured by payments, in minor units of the row's currency, on the day it was captured.",
  refundedMinor:
    "Money refunded, in minor units of the row's currency, on the day of the refund and not the order's day.",
  netCapturedMinor:
    "Captured less refunded, in minor units of the row's currency. It includes any tax and shipping the customer paid. A refund counts on its own day, so a day's figure can be negative.",
  paidOrders:
    'Orders paid, counted on the day they were paid; an imported order counts on the day it was placed.',
  viewers:
    'Browsers that ran the storefront script and viewed a product, once per browser per store day and summed per day across a range, so the same browser on two days counts twice. A visitor and the customer it signs in as are two.',
  cartsWithItems: 'Carts that had an item added, each counted once per store day.',
  checkoutsStarted: 'Orders that started a payment, each counted once per store day.',
  paymentsFailed:
    'Payments the provider declined. A captured payment that could not confirm its order is not counted.',
  units: 'Units on paid orders, before any refund.',
  lineSubtotalMinor:
    "Line subtotals of paid orders in minor units of the row's currency, before any refund.",
  searches:
    'Searches on the search page that found nothing, counted per search and not per person.',
  stock: 'Stock on hand now.',
  unitsSold: 'Units on paid orders over the windowDays closed days.',
  windowDays: 'The closed days unitsSold covers: the last 28, or fewer from since.',
  daysLeft: 'stock divided by unitsSold per day over windowDays; 0 when no stock is left.',
  since:
    'The earliest day with any figure. A day before it has no row; a day after it with no row had none of that figure.',
  rate: 'A ratio computed for this response and never stored; quote it with its basis.',
} as const

export const RATE_FLOORS = { viewers: 20, checkoutsStarted: 5, cartsWithItems: 5 } as const

/** The orders a rate leaves out: its parts count storefront orders only. */
export const RATE_EXCLUDED_SOURCES = ['import', 'agent:*'] as const

const parts = `storefront orders only (${RATE_EXCLUDED_SOURCES.join(' and ')} excluded), over the closed days of the window`

export const RATE_BASIS = {
  paidPerCheckoutStarted: `Paid orders divided by checkouts started, ${parts}.`,
  paidPerCartWithItems: `Paid orders divided by carts with items, ${parts}.`,
  paidPerMeasuredViewer: `Paid orders divided by measured viewers, ${parts}.`,
} as const

const NOT_DECLINES = new Set([
  'no_order',
  'order_cancelled_refunded',
  'duplicate_capture_refunded',
  'amount_mismatch',
  'malformed_capture',
])
const NOT_DECLINE_PREFIXES = ['order_not_pending:', 'duplicate_capture_refund_', 'stock_unavailable:']

/**
 * Whether a `payment.failed.v1` reason is a payment the provider declined, rather than a captured payment that could
 * not confirm its order. Named exclusions, not inclusions, since a decline's reason is the provider's own free text;
 * a new reason for a capture that fails to confirm must join these.
 */
export function isDecline(reason: string): boolean {
  if (NOT_DECLINES.has(reason)) return false
  return !NOT_DECLINE_PREFIXES.some((prefix) => reason.startsWith(prefix))
}
