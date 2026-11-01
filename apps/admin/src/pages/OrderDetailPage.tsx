import { useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  ArrowLeft,
  Mail,
  CreditCard,
  Clock,
  MessageSquare,
  Package,
  CheckCircle,
  XCircle,
  Truck,
  History,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { OrderStatusBadge } from '@/components/orders/OrderStatusBadge'
import { OrderStatusSelect } from '@/components/orders/OrderStatusSelect'
import { OrderTimeline } from '@/components/orders/OrderTimeline'
import { OrderNotesPanel } from '@/components/orders/OrderNotesPanel'
import { OrderRefundDialog } from '@/components/orders/OrderRefundDialog'
import { ShipOrderDialog } from '@/components/orders/ShipOrderDialog'
import { HistoryTab } from '@/components/history/HistoryTab'
import {
  useOrder,
  useOrderNotes,
  useMarkPaidOrder,
  useCancelOrder,
  useMarkDeliveredOrder,
  useResendConfirmation,
} from '@/hooks/useOrders'
import { ApiError } from '@/lib/api'
import { formatMoney } from '@/lib/money'
import { formatDate } from '@/lib/dates'
import { tid } from '@/lib/testid'
import { cn } from '@/lib/utils'
import type { CaptureMethod, Order, OrderPayment, OrderRefund, OrderStatus } from '@nymbalhq/types'

/** No confirmation is due before payment, and a cancelled order was never paid: the server refuses both. */
const NO_CONFIRMATION_DUE: readonly OrderStatus[] = ['pending', 'cancelled']

const PAYMENT_STATE_LABELS: Record<OrderPayment['state'], string> = {
  unpaid: 'Unpaid',
  paid: 'Paid',
  partially_refunded: 'Partially refunded',
  refunded: 'Refunded',
}

const PAYMENT_STATE_STYLES: Record<OrderPayment['state'], string> = {
  unpaid: 'bg-zinc-100 text-zinc-700',
  paid: 'bg-green-100 text-green-700',
  partially_refunded: 'bg-amber-100 text-amber-700',
  refunded: 'bg-orange-100 text-orange-700',
}

const CAPTURE_METHOD_LABELS: Record<CaptureMethod, string> = {
  provider: 'Payment provider',
  manual: 'Recorded manually',
  import: 'Imported',
}

const REFUND_STATUS_LABELS: Record<OrderRefund['status'], string> = {
  pending: 'Refund pending',
  succeeded: 'Refunded',
  failed: 'Failed',
}

/** What was captured and refunded, from the stored amounts alone: never from the intent or the status. */
function PaymentPanel({ order }: { order: Order & { payment: OrderPayment } }) {
  const { payment } = order
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Payment</h3>
        <span
          className={cn(
            'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
            PAYMENT_STATE_STYLES[payment.state],
          )}
          data-testid={tid('order', 'payment-state')}
        >
          {PAYMENT_STATE_LABELS[payment.state]}
        </span>
      </div>
      <dl className="space-y-1.5 text-sm">
        <div className="flex justify-between">
          <dt className="text-zinc-500">Captured</dt>
          <dd className="font-mono text-zinc-700" data-testid={tid('order', 'captured')}>
            {formatMoney(payment.capturedMinor, payment.currency)}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-zinc-500">Refunded</dt>
          <dd className="font-mono text-zinc-700" data-testid={tid('order', 'refunded')}>
            {formatMoney(payment.refundedMinor, payment.currency)}
          </dd>
        </div>
        <div className="flex justify-between font-semibold">
          <dt className="text-zinc-700">Net</dt>
          <dd className="font-mono text-zinc-900" data-testid={tid('order', 'net')}>
            {formatMoney(payment.capturedMinor - payment.refundedMinor, payment.currency)}
          </dd>
        </div>
        {order.captureMethod && (
          <div className="flex justify-between">
            <dt className="text-zinc-500">Method</dt>
            <dd className="text-zinc-700">{CAPTURE_METHOD_LABELS[order.captureMethod]}</dd>
          </div>
        )}
        {order.paymentIntentId && (
          <div className="flex justify-between">
            <dt className="text-zinc-500">Intent ID</dt>
            <dd className="font-mono text-xs text-zinc-600 truncate max-w-[120px]">
              {order.paymentIntentId}
            </dd>
          </div>
        )}
      </dl>
      {payment.refunds.length > 0 && (
        <ul className="space-y-1 border-t border-zinc-100 pt-2 text-sm">
          {payment.refunds.map((refund) => (
            <li
              key={refund.id}
              className="flex justify-between gap-2"
              data-testid={tid('order', 'refund-row', refund.id)}
            >
              <span className="text-zinc-500">
                {REFUND_STATUS_LABELS[refund.status]} · {formatDate(refund.createdAt)}
              </span>
              <span className="font-mono text-zinc-700">
                {formatMoney(refund.amountMinor, refund.currency)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AddressBlock({ address, label }: { address: Order['billingAddress']; label: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-400 mb-1.5">{label}</p>
      <div className="text-sm text-zinc-600 space-y-0.5">
        <p>
          {address.firstName} {address.lastName}
        </p>
        {address.company && <p>{address.company}</p>}
        <p>{address.addressLine1}</p>
        {address.addressLine2 && <p>{address.addressLine2}</p>}
        <p>
          {address.city}, {address.region} {address.postalCode}
        </p>
        <p>{address.country}</p>
      </div>
    </div>
  )
}

export function OrderDetailPage() {
  const { orderNumber } = useParams<{ orderNumber: string }>()
  const [showRefund, setShowRefund] = useState(false)
  const [showShip, setShowShip] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  // Set in the click itself: `isPending` reaches the button only after a render, too late for a double click.
  const acting = useRef(false)
  const [busy, setBusy] = useState(false)

  const { data: order, isLoading } = useOrder(orderNumber ?? '')
  const { data: notes = [] } = useOrderNotes(order?.id ?? '')
  const markPaid = useMarkPaidOrder()
  const cancelOrder = useCancelOrder()
  const markDelivered = useMarkDeliveredOrder()
  const resend = useResendConfirmation()

  /** Runs one order action at a time and says why the server refused it. */
  const runAction = async (send: () => Promise<unknown>) => {
    if (acting.current) return
    acting.current = true
    setBusy(true)
    setActionError(null)
    try {
      await send()
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'The order could not be updated.')
    } finally {
      acting.current = false
      setBusy(false)
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <div className="grid grid-cols-1 gap-5 md:grid-cols-5">
          <div className="md:col-span-3 space-y-4">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
          <div className="md:col-span-2 space-y-4">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        </div>
      </div>
    )
  }

  if (!order) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Package className="mb-3 h-8 w-8 text-zinc-300" />
        <p className="text-sm text-zinc-500">Order not found</p>
        <Link to="/orders" className="mt-3 text-sm text-blue-600 hover:underline">
          ← Back to orders
        </Link>
      </div>
    )
  }

  const primaryAction = () => {
    if (order.status === 'pending' && order.payment.capturedMinor === 0)
      return {
        label: 'Record payment',
        icon: CheckCircle,
        action: () => void runAction(() => markPaid.mutateAsync({ orderId: order.id })),
      }
    if (order.status === 'processing')
      return {
        label: 'Mark Shipped',
        icon: Truck,
        action: () => setShowShip(true),
      }
    if (order.status === 'shipped')
      return {
        label: 'Mark Delivered',
        icon: CheckCircle,
        action: () => void runAction(() => markDelivered.mutateAsync(order.id)),
      }
    return null
  }

  const primary = primaryAction()
  const resendDisabled = NO_CONFIRMATION_DUE.includes(order.status) || resend.isPending
  const resendResult = resend.isError
    ? resend.error.message
    : resend.data
      ? `Confirmation queued to ${resend.data.email}`
      : null

  return (
    <div className="space-y-4" data-testid={tid('order', 'detail')}>
      {/* Back + header */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/orders"
            className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Orders
          </Link>
          <span className="text-zinc-300">/</span>
          <h1 className="font-mono text-base font-semibold text-zinc-900">#{order.orderNumber}</h1>
          <OrderStatusBadge status={order.status} data-testid={tid('order', 'status-badge')} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actionError !== null && (
            <span
              role="alert"
              className="text-xs text-red-600"
              data-testid={tid('order', 'action-error')}
            >
              {actionError}
            </span>
          )}
          {resendResult !== null && (
            <span
              role="status"
              className="text-xs text-zinc-500"
              data-testid={tid('order', 'resend-result')}
            >
              {resendResult}
            </span>
          )}
          {primary && (
            <Button
              size="sm"
              onClick={primary.action}
              disabled={busy}
              className="gap-1.5"
              data-testid={tid('order', 'primary-action')}
            >
              <primary.icon className="h-4 w-4" />
              {primary.label}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" data-testid={tid('order', 'actions')}>
                Actions
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                onSelect={() => {
                  if (!resendDisabled) resend.mutate({ orderId: order.id })
                }}
                className="gap-2"
                disabled={resendDisabled}
                data-testid={tid('order', 'action', 'resend-confirmation')}
              >
                <Mail className="h-4 w-4" />
                Resend confirmation
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {order.payment.refundableMinor > 0 && (
                <DropdownMenuItem
                  onClick={() => setShowRefund(true)}
                  className="gap-2"
                  data-testid={tid('order', 'action', 'refund')}
                >
                  <CreditCard className="h-4 w-4" />
                  Issue refund
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => void runAction(() => cancelOrder.mutateAsync({ orderId: order.id }))}
                className="gap-2 text-red-600"
                data-testid={tid('order', 'action', 'cancel')}
                disabled={
                  order.payment.capturedMinor > 0 ||
                  ['cancelled', 'refunded', 'delivered'].includes(order.status)
                }
              >
                <XCircle className="h-4 w-4" />
                Cancel order
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Order date + status select */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-zinc-500">
        <span className="flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5" />
          Placed {formatDate(order.createdAt)}
        </span>
        <span className="text-zinc-300">·</span>
        <OrderStatusSelect
          orderId={order.id}
          currentStatus={order.status}
          orderNumber={order.orderNumber}
          capturedMinor={order.payment.capturedMinor}
        />
      </div>

      {/* Main layout */}
      <div className="grid grid-cols-1 gap-5 md:grid-cols-5">
        {/* Left 3/5 */}
        <div className="md:col-span-3 space-y-5">
          {/* Line items */}
          <div className="rounded-lg border border-zinc-200 bg-white overflow-hidden">
            <div className="border-b border-zinc-100 px-4 py-3">
              <h2 className="text-sm font-semibold text-zinc-900">
                Items ({order.lineItems.length})
              </h2>
            </div>
            <div className="divide-y divide-zinc-50">
              {order.lineItems.map((item) => (
                <div key={item.variantId} className="flex items-start gap-3 px-4 py-3">
                  {item.imageUrl ? (
                    <img
                      src={item.imageUrl}
                      alt={item.productName}
                      className="h-12 w-12 rounded border border-zinc-100 object-cover"
                    />
                  ) : (
                    <div className="flex h-12 w-12 items-center justify-center rounded border border-zinc-100 bg-zinc-50">
                      <Package className="h-5 w-5 text-zinc-300" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-800">{item.productName}</p>
                    <p className="text-xs text-zinc-400">
                      {item.variantName} · {item.sku}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-sm text-zinc-700">
                      {formatMoney(item.lineTotalMinor, order.currency)}
                    </p>
                    <p className="text-xs text-zinc-400">
                      {item.qty} × {formatMoney(item.unitPriceMinor, order.currency)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            {/* Totals */}
            <div className="border-t border-zinc-100 bg-zinc-50 px-4 py-3 space-y-1">
              <div className="flex justify-between text-sm text-zinc-500">
                <span>Subtotal</span>
                <span className="font-mono">
                  {formatMoney(order.subtotalMinor, order.currency)}
                </span>
              </div>
              {order.taxTotalMinor > 0 && (
                <div className="flex justify-between text-sm text-zinc-500">
                  <span>Tax</span>
                  <span className="font-mono">
                    {formatMoney(order.taxTotalMinor, order.currency)}
                  </span>
                </div>
              )}
              {order.shippingTotalMinor > 0 && (
                <div className="flex justify-between text-sm text-zinc-500">
                  <span>Shipping</span>
                  <span className="font-mono">
                    {formatMoney(order.shippingTotalMinor, order.currency)}
                  </span>
                </div>
              )}
              {order.discountTotalMinor > 0 && (
                <div className="flex justify-between text-sm text-green-600">
                  <span>Discount</span>
                  <span className="font-mono">
                    -{formatMoney(order.discountTotalMinor, order.currency)}
                  </span>
                </div>
              )}
              <div className="flex justify-between border-t border-zinc-200 pt-2 text-sm font-semibold text-zinc-800">
                <span>Total</span>
                <span className="font-mono text-base">
                  {formatMoney(order.totalMinor, order.currency)}
                </span>
              </div>
            </div>
          </div>

          {/* Notes & Timeline */}
          <div className="rounded-lg border border-zinc-200 bg-white overflow-hidden">
            <Tabs defaultValue="notes">
              <div className="border-b border-zinc-100 px-4 py-2">
                <TabsList className="h-8">
                  <TabsTrigger value="notes" className="gap-1.5 text-xs">
                    <MessageSquare className="h-3.5 w-3.5" />
                    Notes
                    {notes.length > 0 && (
                      <span className="rounded-full bg-zinc-100 px-1.5 text-[10px]">
                        {notes.length}
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger
                    value="timeline"
                    className="gap-1.5 text-xs"
                    data-testid={tid('order', 'tab', 'timeline')}
                  >
                    <Clock className="h-3.5 w-3.5" />
                    Timeline
                  </TabsTrigger>
                  <TabsTrigger
                    value="history"
                    className="gap-1.5 text-xs"
                    data-testid={tid('order', 'tab', 'history')}
                  >
                    <History className="h-3.5 w-3.5" />
                    History
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="notes" className="p-4">
                <OrderNotesPanel orderId={order.id} notes={notes} />
              </TabsContent>
              <TabsContent value="timeline" className="p-4">
                {order.history && order.history.length > 0 ? (
                  <OrderTimeline entries={order.history} />
                ) : (
                  <p className="text-sm text-zinc-400 text-center py-4">No history yet.</p>
                )}
              </TabsContent>
              <TabsContent value="history" className="p-4">
                <HistoryTab
                  collection="orders"
                  id={order.id}
                  detailPath={`/api/admin/orders/${encodeURIComponent(order.orderNumber)}`}
                />
              </TabsContent>
            </Tabs>
          </div>
        </div>

        {/* Right 2/5 */}
        <div className="md:col-span-2 space-y-4">
          {/* Customer */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Customer
            </h3>
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-sm font-semibold text-zinc-600">
                {(order.email[0] ?? '?').toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-800 [overflow-wrap:anywhere]">
                  {order.email}
                </p>
                {order.customerId && (
                  <Link
                    to={`/customers/${order.customerId}`}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    View customer →
                  </Link>
                )}
              </div>
            </div>
          </div>

          {/* Addresses */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-3">
              Addresses
            </h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <AddressBlock address={order.shippingAddress} label="Shipping" />
              <AddressBlock address={order.billingAddress} label="Billing" />
            </div>
          </div>

          <PaymentPanel order={order} />

          {/* Notes */}
          {order.notes && (
            <div className="rounded-lg border border-zinc-200 bg-amber-50 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-600 mb-1.5">
                Order Note
              </h3>
              <p className="text-sm text-amber-800">{order.notes}</p>
            </div>
          )}
        </div>
      </div>

      {showRefund && <OrderRefundDialog order={order} onClose={() => setShowRefund(false)} />}
      <ShipOrderDialog
        orderId={order.id}
        orderNumber={order.orderNumber}
        open={showShip}
        onOpenChange={setShowShip}
      />
    </div>
  )
}

export const orderDetailHandle = {
  breadcrumb: (params: Record<string, string | undefined>) => `#${params['orderNumber'] ?? ''}`,
}
