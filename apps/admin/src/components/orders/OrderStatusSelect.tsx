import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useUpdateOrderStatus } from '@/hooks/useOrders'
import { ORDER_STATUS_TRANSITIONS } from '@/types'
import type { OrderStatus } from '@/types'
import { tid } from '@/lib/testid'
import { cn } from '@/lib/utils'

interface OrderStatusSelectProps {
  orderId: string
  currentStatus: OrderStatus
  orderNumber: string
}

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
  processing: 'confirm',
  shipped: 'ship',
  delivered: 'mark-delivered',
  cancelled: 'cancel',
  refunded: 'refund',
}

export function OrderStatusSelect({ orderId, currentStatus, orderNumber }: OrderStatusSelectProps) {
  const queryClient = useQueryClient()
  const { mutateAsync: updateStatus, isPending } = useUpdateOrderStatus()
  const [optimisticStatus, setOptimisticStatus] = useState<OrderStatus | null>(null)

  const nextStatuses = ORDER_STATUS_TRANSITIONS[currentStatus]
  const displayStatus = optimisticStatus ?? currentStatus

  if (nextStatuses.length === 0) {
    return (
      <span className="text-sm text-zinc-500 font-medium capitalize">
        {STATUS_LABELS[currentStatus]}
      </span>
    )
  }

  const handleChange = async (value: string) => {
    const newStatus = value as OrderStatus
    const action = ACTION_MAP[newStatus] ?? newStatus
    setOptimisticStatus(newStatus)

    try {
      await updateStatus({ orderId, action })
    } catch {
      setOptimisticStatus(null)
      queryClient.invalidateQueries({ queryKey: ['orders', 'detail', orderNumber] })
    }
  }

  return (
    <Select
      value={displayStatus}
      onValueChange={(v) => void handleChange(v)}
      disabled={isPending}
    >
      <SelectTrigger
        className={cn('w-44 h-8 text-xs', isPending && 'opacity-50')}
        data-testid={tid('order', 'status-select')}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={currentStatus} disabled>
          {STATUS_LABELS[currentStatus]} (current)
        </SelectItem>
        {nextStatuses.map((status) => (
          <SelectItem key={status} value={status}>
            {STATUS_LABELS[status]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
