import { useState } from 'react'
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
import { useOrder, useOrderNotes, useConfirmOrder, useCancelOrder, useMarkDeliveredOrder, useShipOrder } from '@/hooks/useOrders'
import { formatMoney } from '@/lib/money'
import { formatDate } from '@/lib/dates'
import { tid } from '@/lib/testid'
import type { Order } from '@/types'

function AddressBlock({ address, label }: { address: Order['billingAddress']; label: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wider text-zinc-400 mb-1.5">{label}</p>
      <div className="text-sm text-zinc-600 space-y-0.5">
        <p>{address.line1}</p>
        {address.line2 && <p>{address.line2}</p>}
        <p>{address.city}, {address.state} {address.postalCode}</p>
        <p>{address.country}</p>
      </div>
    </div>
  )
}

export function OrderDetailPage() {
  const { orderNumber } = useParams<{ orderNumber: string }>()
  const [showRefund, setShowRefund] = useState(false)

  const { data: order, isLoading } = useOrder(orderNumber ?? '')
  const { data: notes = [] } = useOrderNotes(order?.id ?? '')
  const confirmOrder = useConfirmOrder()
  const cancelOrder = useCancelOrder()
  const markDelivered = useMarkDeliveredOrder()
  const shipOrder = useShipOrder()

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <div className="grid grid-cols-5 gap-5">
          <div className="col-span-3 space-y-4">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
          <div className="col-span-2 space-y-4">
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
        <Link to="/admin/orders" className="mt-3 text-sm text-blue-600 hover:underline">
          ← Back to orders
        </Link>
      </div>
    )
  }

  const primaryAction = () => {
    if (order.status === 'pending')
      return { label: 'Confirm Order', icon: CheckCircle, action: () => void confirmOrder.mutateAsync(order.id) }
    if (order.status === 'processing')
      return {
        label: 'Mark Shipped',
        icon: Truck,
        action: () =>
          void shipOrder.mutateAsync({
            orderId: order.id,
            trackingNumber: '',
            carrier: '',
          }),
      }
    if (order.status === 'shipped')
      return { label: 'Mark Delivered', icon: CheckCircle, action: () => void markDelivered.mutateAsync(order.id) }
    return null
  }

  const primary = primaryAction()

  return (
    <div className="space-y-4" data-testid={tid('order', 'detail')}>
      {/* Back + header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Link
            to="/admin/orders"
            className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Orders
          </Link>
          <span className="text-zinc-300">/</span>
          <h1 className="font-mono text-base font-semibold text-zinc-900">#{order.orderNumber}</h1>
          <OrderStatusBadge status={order.status} data-testid={tid('order', 'status-badge')} />
        </div>
        <div className="flex items-center gap-2">
          {primary && (
            <Button size="sm" onClick={primary.action} className="gap-1.5">
              <primary.icon className="h-4 w-4" />
              {primary.label}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Actions
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem className="gap-2">
                <Mail className="h-4 w-4" />
                Resend confirmation
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {(order.status === 'delivered') && (
                <DropdownMenuItem onClick={() => setShowRefund(true)} className="gap-2">
                  <CreditCard className="h-4 w-4" />
                  Issue refund
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => void cancelOrder.mutateAsync({ orderId: order.id })}
                className="gap-2 text-red-600"
                disabled={['cancelled', 'refunded', 'delivered'].includes(order.status)}
              >
                <XCircle className="h-4 w-4" />
                Cancel order
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Order date + status select */}
      <div className="flex items-center gap-4 text-sm text-zinc-500">
        <span className="flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5" />
          Placed {formatDate(order.createdAt)}
        </span>
        <span className="text-zinc-300">·</span>
        <OrderStatusSelect
          orderId={order.id}
          currentStatus={order.status}
          orderNumber={order.orderNumber}
        />
      </div>

      {/* Main layout */}
      <div className="grid grid-cols-5 gap-5">
        {/* Left 3/5 */}
        <div className="col-span-3 space-y-5">
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
                    <p className="text-xs text-zinc-400">{item.variantName} · {item.sku}</p>
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
                <span className="font-mono">{formatMoney(order.subtotalMinor, order.currency)}</span>
              </div>
              {order.taxTotalMinor > 0 && (
                <div className="flex justify-between text-sm text-zinc-500">
                  <span>Tax</span>
                  <span className="font-mono">{formatMoney(order.taxTotalMinor, order.currency)}</span>
                </div>
              )}
              {order.shippingTotalMinor > 0 && (
                <div className="flex justify-between text-sm text-zinc-500">
                  <span>Shipping</span>
                  <span className="font-mono">{formatMoney(order.shippingTotalMinor, order.currency)}</span>
                </div>
              )}
              {order.discountTotalMinor > 0 && (
                <div className="flex justify-between text-sm text-green-600">
                  <span>Discount</span>
                  <span className="font-mono">-{formatMoney(order.discountTotalMinor, order.currency)}</span>
                </div>
              )}
              <div className="flex justify-between border-t border-zinc-200 pt-2 text-sm font-semibold text-zinc-800">
                <span>Total</span>
                <span className="font-mono text-base">{formatMoney(order.totalMinor, order.currency)}</span>
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
                      <span className="rounded-full bg-zinc-100 px-1.5 text-[10px]">{notes.length}</span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="timeline" className="gap-1.5 text-xs">
                    <Clock className="h-3.5 w-3.5" />
                    Timeline
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
            </Tabs>
          </div>
        </div>

        {/* Right 2/5 */}
        <div className="col-span-2 space-y-4">
          {/* Customer */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Customer</h3>
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 text-sm font-semibold text-zinc-600">
                {(order.email[0] ?? '?').toUpperCase()}
              </div>
              <div>
                <p className="text-sm font-medium text-zinc-800">{order.email}</p>
                {order.customerId && (
                  <Link
                    to={`/admin/customers/${order.customerId}`}
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
            <div className="grid grid-cols-2 gap-4">
              <AddressBlock address={order.shippingAddress} label="Shipping" />
              <AddressBlock address={order.billingAddress} label="Billing" />
            </div>
          </div>

          {/* Payment */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Payment</h3>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-500">Status</span>
                <span className="font-medium text-zinc-700">
                  {order.paymentIntentId ? 'Paid' : 'Unpaid'}
                </span>
              </div>
              {order.paymentIntentId && (
                <div className="flex justify-between">
                  <span className="text-zinc-500">Intent ID</span>
                  <span className="font-mono text-xs text-zinc-600 truncate max-w-[120px]">
                    {order.paymentIntentId}
                  </span>
                </div>
              )}
              <div className="flex justify-between font-semibold">
                <span className="text-zinc-700">Total charged</span>
                <span className="font-mono text-zinc-900">
                  {formatMoney(order.totalMinor, order.currency)}
                </span>
              </div>
            </div>
          </div>

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

      {showRefund && (
        <OrderRefundDialog
          order={order}
          onClose={() => setShowRefund(false)}
        />
      )}
    </div>
  )
}

export const orderDetailHandle = {
  breadcrumb: (params: Record<string, string | undefined>) => `#${params['orderNumber'] ?? ''}`,
}
