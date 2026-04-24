import { useNavigate } from 'react-router-dom'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { OrderStatusBadge } from '@/components/orders/OrderStatusBadge'
import { EmptyState } from '@/components/common/EmptyState'
import { formatMoney } from '@/lib/money'
import { formatRelative } from '@/lib/dates'
import { ShoppingBag } from 'lucide-react'
import type { Order } from '@/types'

interface CustomerOrdersTableProps {
  orders: Order[] | undefined
  isLoading?: boolean
}

export function CustomerOrdersTable({ orders, isLoading }: CustomerOrdersTableProps) {
  const navigate = useNavigate()

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    )
  }

  if (!orders || orders.length === 0) {
    return (
      <EmptyState
        icon={<ShoppingBag className="h-5 w-5" />}
        title="No orders"
        description="This customer hasn't placed any orders yet."
      />
    )
  }

  return (
    <div className="rounded-md border border-zinc-200 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Order #</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Items</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead className="text-right">Date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.map((order) => (
            <TableRow
              key={order.id}
              className="cursor-pointer"
              onClick={() => navigate(`/admin/orders/${order.orderNumber}`)}
            >
              <TableCell className="font-mono text-sm font-medium text-blue-600">
                #{order.orderNumber}
              </TableCell>
              <TableCell>
                <OrderStatusBadge status={order.status} />
              </TableCell>
              <TableCell className="text-zinc-500">
                {order.lineItems.length} item{order.lineItems.length !== 1 ? 's' : ''}
              </TableCell>
              <TableCell className="text-right font-mono text-sm">
                {formatMoney(order.totalMinor, order.currency)}
              </TableCell>
              <TableCell className="text-right text-sm text-zinc-500">
                {formatRelative(order.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
