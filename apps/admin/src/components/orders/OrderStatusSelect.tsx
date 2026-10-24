import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useMarkPaidOrder, useUpdateOrderStatus } from '@/hooks/useOrders'
import { ORDER_STATUS_TRANSITIONS } from '@nymbalhq/types'
import type { OrderStatus } from '@nymbalhq/types'
import { tid } from '@/lib/testid'
import { cn } from '@/lib/utils'

interface OrderStatusSelectProps {
  orderId: string
  currentStatus: OrderStatus
  orderNumber: string
  /** What the order captured: a paid order is refunded through the refund dialog, never cancelled. */
  capturedMinor: number
}

/** The select's value for recording a payment taken outside the store (mark-paid), which confirms a pending order. */
const RECORD_PAYMENT = 'record-payment'

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  processing: 'Processing',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  partially_refunded: 'Partially Refunded',
}

const ACTION_MAP: Partial<Record<OrderStatus, string>> = {
  confirmed: 'confirm',
  processing: 'process',
  shipped: 'ship',
  delivered: 'mark-delivered',
  cancelled: 'cancel',
}

/**
 * The moves the select offers: refunds go through the refund dialog, only money confirms an order (Record payment),
 * and an order that captured anything is never cancelled.
 */
function offeredStatuses(currentStatus: OrderStatus, capturedMinor: number): OrderStatus[] {
  return ORDER_STATUS_TRANSITIONS[currentStatus].filter(
    (status) =>
      status !== 'refunded' &&
      status !== 'partially_refunded' &&
      status !== 'confirmed' &&
      !(status === 'cancelled' && capturedMinor > 0),
  )
}

export function OrderStatusSelect({
  orderId,
  currentStatus,
  orderNumber,
  capturedMinor,
}: OrderStatusSelectProps) {
  const queryClient = useQueryClient()
  const { mutateAsync: updateStatus, isPending: isUpdating } = useUpdateOrderStatus()
  const { mutateAsync: markPaid, isPending: isRecording } = useMarkPaidOrder()
  const [optimisticStatus, setOptimisticStatus] = useState<OrderStatus | null>(null)

  const nextStatuses = offeredStatuses(currentStatus, capturedMinor)
  const canRecordPayment = currentStatus === 'pending' && capturedMinor === 0
  const displayStatus = optimisticStatus ?? currentStatus
  const isPending = isUpdating || isRecording

  if (nextStatuses.length === 0 && !canRecordPayment) {
    return (
      <span className="text-sm text-zinc-500 font-medium capitalize">
        {STATUS_LABELS[currentStatus]}
      </span>
    )
  }

  const handleChange = async (value: string) => {
    const newStatus = value === RECORD_PAYMENT ? 'confirmed' : (value as OrderStatus)
    setOptimisticStatus(newStatus)

    try {
      if (value === RECORD_PAYMENT) await markPaid({ orderId })
      else await updateStatus({ orderId, action: ACTION_MAP[newStatus] ?? newStatus })
    } catch (err) {
      console.error('[OrderStatusSelect] status update failed', err)
      setOptimisticStatus(null)
      queryClient.invalidateQueries({ queryKey: ['orders', 'detail', orderNumber] })
    }
  }

  return (
    <Select value={displayStatus} onValueChange={(v) => void handleChange(v)} disabled={isPending}>
      <SelectTrigger
        className={cn('w-44 h-8 text-xs', isPending && 'opacity-50')}
        aria-label="Order status"
        data-testid={tid('order', 'status-select')}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem
          value={currentStatus}
          disabled
          data-testid={tid('order', 'status-option', currentStatus)}
        >
          {STATUS_LABELS[currentStatus]} (current)
        </SelectItem>
        {canRecordPayment && (
          <SelectItem
            value={RECORD_PAYMENT}
            data-testid={tid('order', 'status-option', RECORD_PAYMENT)}
          >
            Record payment
          </SelectItem>
        )}
        {nextStatuses.map((status) => (
          <SelectItem
            key={status}
            value={status}
            data-testid={tid('order', 'status-option', status)}
          >
            {STATUS_LABELS[status]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
