import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  MoreHorizontal,
  Search,
  Filter,
  Package,
  Trash2,
  CheckCheck,
} from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { OrderStatusBadge } from '@/components/orders/OrderStatusBadge'
import { EmptyState } from '@/components/common/EmptyState'
import { useOrders } from '@/hooks/useOrders'
import { formatMoney } from '@/lib/money'
import { formatRelative } from '@/lib/dates'
import { tid } from '@/lib/testid'
import { cn } from '@/lib/utils'
import type { OrderStatus } from '@/types'

const STATUS_FILTERS: { label: string; value: OrderStatus | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Pending', value: 'pending' },
  { label: 'Confirmed', value: 'confirmed' },
  { label: 'Processing', value: 'processing' },
  { label: 'Shipped', value: 'shipped' },
  { label: 'Delivered', value: 'delivered' },
  { label: 'Cancelled', value: 'cancelled' },
]

export function OrdersListPage() {
  const navigate = useNavigate()
  const [statusFilter, setStatusFilter] = useState<OrderStatus | 'all'>('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const { data: orders, isLoading } = useOrders({
    status: statusFilter === 'all' ? undefined : statusFilter,
    q: search || undefined,
    sort: 'createdAt:desc',
    limit: 100,
  })

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (!orders) return
    if (selected.size === orders.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(orders.map((o) => o.id)))
    }
  }

  const allSelected = orders ? selected.size === orders.length && orders.length > 0 : false

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Orders</h1>
          <p className="text-sm text-zinc-500">
            {orders ? `${orders.length} orders` : 'Loading...'}
          </p>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        {/* Status chips */}
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setStatusFilter(f.value)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                statusFilter === f.value
                  ? 'bg-zinc-900 text-white'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex flex-1 items-center gap-2 sm:justify-end">
          <div className="relative flex-1 sm:max-w-xs">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              placeholder="Search orders..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-8 text-sm"
            />
          </div>
          <Button variant="outline" size="sm" className="gap-1.5">
            <Filter className="h-3.5 w-3.5" />
            Filter
          </Button>
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-md border border-blue-200 bg-blue-50 px-4 py-2.5">
          <span className="text-sm font-medium text-blue-700">
            {selected.size} selected
          </span>
          <div className="flex items-center gap-2 ml-auto">
            <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs border-blue-200 text-blue-700 hover:bg-blue-100">
              <CheckCheck className="h-3.5 w-3.5" />
              Confirm All
            </Button>
            <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs border-red-200 text-red-600 hover:bg-red-50">
              <Trash2 className="h-3.5 w-3.5" />
              Cancel All
            </Button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border border-zinc-200 bg-white overflow-hidden">
        {isLoading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : !orders?.length ? (
          <EmptyState
            icon={<Package className="h-5 w-5" />}
            title="No orders found"
            description={search || statusFilter !== 'all' ? 'Try adjusting your filters.' : 'Orders will appear here as they come in.'}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 pl-4">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={toggleAll}
                    aria-label="Select all"
                  />
                </TableHead>
                <TableHead>Order #</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-center">Items</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Date</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow
                  key={order.id}
                  data-testid={tid('orders', 'row', order.orderNumber)}
                  data-state={selected.has(order.id) ? 'selected' : undefined}
                  className={cn(
                    'cursor-pointer',
                    selected.has(order.id) && 'bg-blue-50/50'
                  )}
                >
                  <TableCell className="pl-4" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(order.id)}
                      onCheckedChange={() => toggleSelect(order.id)}
                      aria-label={`Select order ${order.orderNumber}`}
                    />
                  </TableCell>
                  <TableCell
                    className="font-mono text-sm font-medium text-blue-600 cursor-pointer"
                    onClick={() => navigate(`/admin/orders/${order.orderNumber}`)}
                  >
                    #{order.orderNumber}
                  </TableCell>
                  <TableCell
                    className="text-zinc-600 cursor-pointer"
                    onClick={() => navigate(`/admin/orders/${order.orderNumber}`)}
                  >
                    <div className="truncate max-w-[180px]">{order.email}</div>
                  </TableCell>
                  <TableCell onClick={() => navigate(`/admin/orders/${order.orderNumber}`)}>
                    <OrderStatusBadge status={order.status} />
                  </TableCell>
                  <TableCell className="text-center text-zinc-500" onClick={() => navigate(`/admin/orders/${order.orderNumber}`)}>
                    {order.lineItems.length}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm" onClick={() => navigate(`/admin/orders/${order.orderNumber}`)}>
                    {formatMoney(order.totalMinor, order.currency)}
                  </TableCell>
                  <TableCell className="text-right text-sm text-zinc-400" onClick={() => navigate(`/admin/orders/${order.orderNumber}`)}>
                    {formatRelative(order.createdAt)}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 text-zinc-400">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => navigate(`/admin/orders/${order.orderNumber}`)}>
                          View details
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-red-600">Cancel order</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

// Route handle for breadcrumbs
export const ordersListHandle = {
  breadcrumb: () => 'Orders',
}
