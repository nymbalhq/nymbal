import { canRefund, fulfilmentMoves } from '@nymbalhq/types'
import type { AdminOrder } from '@/types'

export interface PaletteCommand {
  id: string
  label: string
}

export interface NavigationCommand extends PaletteCommand {
  to: string
}

/** The sidebar's pages, then New product. */
export const NAVIGATION_COMMANDS: readonly NavigationCommand[] = [
  { id: 'go-dashboard', label: 'Go to Dashboard', to: '/' },
  { id: 'go-orders', label: 'Go to Orders', to: '/orders' },
  { id: 'go-products', label: 'Go to Products', to: '/products' },
  { id: 'go-categories', label: 'Go to Categories', to: '/categories' },
  { id: 'go-promotions', label: 'Go to Promotions', to: '/promotions' },
  { id: 'go-inventory', label: 'Go to Inventory', to: '/inventory' },
  { id: 'go-customers', label: 'Go to Customers', to: '/customers' },
  { id: 'go-reviews', label: 'Go to Reviews', to: '/reviews' },
  { id: 'go-reports', label: 'Go to Reports', to: '/reports' },
  { id: 'go-activity', label: 'Go to Activity', to: '/activity' },
  { id: 'go-inbox', label: 'Go to Inbox', to: '/inbox' },
  { id: 'go-settings', label: 'Go to Settings', to: '/settings' },
  { id: 'new-product', label: 'New product', to: '/products/new' },
]

export type OrderCommandId =
  | 'record-payment'
  | 'process'
  | 'ship'
  | 'deliver'
  | 'refund'
  | 'cancel'
  | 'resend-confirmation'

export const ORDER_COMMAND_LABELS: Record<OrderCommandId, string> = {
  'record-payment': 'Record payment',
  process: 'Mark processing',
  ship: 'Mark shipped',
  deliver: 'Mark delivered',
  refund: 'Issue refund',
  cancel: 'Cancel order',
  'resend-confirmation': 'Resend confirmation',
}

/** What the server accepts for this order as read, so the palette never offers a move it would refuse. */
export function orderCommands(order: AdminOrder): OrderCommandId[] {
  const { status, payment } = order
  const moves = fulfilmentMoves(status, payment.state)
  const offered: Record<OrderCommandId, boolean> = {
    'record-payment': status === 'pending' && payment.capturedMinor === 0,
    process: moves.includes('processing'),
    ship: moves.includes('shipped'),
    deliver: moves.includes('delivered'),
    refund: canRefund(status) && payment.refundableMinor > 0,
    cancel: moves.includes('cancelled') && payment.capturedMinor === 0,
    'resend-confirmation': status !== 'pending' && status !== 'cancelled',
  }
  return (Object.keys(ORDER_COMMAND_LABELS) as OrderCommandId[]).filter((id) => offered[id])
}

/** Case-insensitive: every whitespace-separated term of the query is a substring of the label. Order kept. */
export function matchCommands<T extends PaletteCommand>(
  query: string,
  commands: readonly T[],
): T[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return commands.filter((c) => {
    const label = c.label.toLowerCase()
    return terms.every((t) => label.includes(t))
  })
}
