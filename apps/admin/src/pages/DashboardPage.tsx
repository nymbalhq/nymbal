import { useNavigate } from 'react-router-dom'
import { ShoppingBag, DollarSign, Truck, AlertTriangle, TrendingUp } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { OrderStatusBadge } from '@/components/orders/OrderStatusBadge'
import { EmptyState } from '@/components/common/EmptyState'
import { useDashboard } from '@/hooks/useDashboard'
import { useMe } from '@/hooks/useMe'
import { formatMoney, formatMoneyCompact } from '@/lib/money'
import { formatRelative } from '@/lib/dates'
import { cn } from '@/lib/utils'
import type { InventoryRow, Order } from '@/types'

function LiveIndicator() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 border border-green-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-green-600">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
      </span>
      Live
    </span>
  )
}

interface StatCardProps {
  icon: React.ReactNode
  label: string
  value: string
  subtext?: string | undefined
  loading?: boolean | undefined
  color?: 'blue' | 'green' | 'violet' | undefined
}

function StatCard({ icon, label, value, subtext, loading, color = 'blue' }: StatCardProps) {
  const colors = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-green-50 text-green-600',
    violet: 'bg-violet-50 text-violet-600',
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5">
      <div className="flex items-start justify-between mb-3">
        <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg', colors[color])}>
          {icon}
        </div>
        <TrendingUp className="h-4 w-4 text-zinc-300" />
      </div>
      {loading ? (
        <>
          <Skeleton className="h-7 w-24 mb-1" />
          <Skeleton className="h-3.5 w-16" />
        </>
      ) : (
        <>
          <p className="text-2xl font-semibold font-mono text-zinc-900">{value}</p>
          <p className="mt-0.5 text-xs text-zinc-500">{label}</p>
          {subtext && <p className="mt-1 text-[11px] text-zinc-400">{subtext}</p>}
        </>
      )}
    </div>
  )
}

export function DashboardPage() {
  const { data: me } = useMe()
  const { data, isLoading } = useDashboard()
  const navigate = useNavigate()

  const currency = 'GBP' // Default; in production this would come from store settings

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">
            {me?.storeName ?? 'Dashboard'}
          </h1>
          <p className="text-sm text-zinc-500">Today's performance at a glance</p>
        </div>
        <LiveIndicator />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard
          icon={<ShoppingBag className="h-4.5 w-4.5" />}
          label="Orders today"
          value={String(data?.today.orderCount ?? 0)}
          loading={isLoading}
          color="blue"
        />
        <StatCard
          icon={<DollarSign className="h-4.5 w-4.5" />}
          label="Revenue today"
          value={data ? formatMoneyCompact(data.today.revenueMinor, currency) : '—'}
          subtext={data ? formatMoney(data.today.revenueMinor, currency) : undefined}
          loading={isLoading}
          color="green"
        />
        <StatCard
          icon={<Truck className="h-4.5 w-4.5" />}
          label="Items shipped"
          value={String(data?.today.itemsShipped ?? 0)}
          loading={isLoading}
          color="violet"
        />
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-3 gap-5">
        {/* Recent orders (2/3 width) */}
        <div className="col-span-2">
          <div className="rounded-lg border border-zinc-200 bg-white overflow-hidden">
            <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
              <h2 className="text-sm font-semibold text-zinc-900">Recent Orders</h2>
              <button
                onClick={() => navigate('/orders')}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium"
              >
                View all →
              </button>
            </div>
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-11 w-full" />
                ))}
              </div>
            ) : !data?.recentOrders?.length ? (
              <EmptyState
                icon={<ShoppingBag className="h-5 w-5" />}
                title="No orders yet"
                description="Orders will appear here as they come in."
              />
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-zinc-100">
                  <tr>
                    <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-zinc-400">Order</th>
                    <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-zinc-400">Customer</th>
                    <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-zinc-400">Status</th>
                    <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-zinc-400">Total</th>
                    <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-zinc-400">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentOrders.map((order: Order) => (
                    <tr
                      key={order.id}
                      className="cursor-pointer border-b border-zinc-50 last:border-0 hover:bg-zinc-50 transition-colors"
                      onClick={() => navigate(`/orders/${order.orderNumber}`)}
                    >
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-sm font-medium text-blue-600">
                          #{order.orderNumber}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-zinc-600 truncate max-w-[160px]">
                        {order.email}
                      </td>
                      <td className="px-4 py-2.5">
                        <OrderStatusBadge status={order.status} size="sm" />
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-sm text-zinc-700">
                        {formatMoney(order.totalMinor, order.currency)}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-zinc-400">
                        {formatRelative(order.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Low stock (1/3 width) */}
        <div>
          <div className="rounded-lg border border-zinc-200 bg-white overflow-hidden">
            <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-zinc-900">Low Stock</h2>
                {data?.lowStock && data.lowStock.length > 0 && (
                  <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                    {data.lowStock.length}
                  </span>
                )}
              </div>
              <button
                onClick={() => navigate('/inventory')}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium"
              >
                Manage →
              </button>
            </div>

            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : !data?.lowStock?.length ? (
              <div className="p-6 text-center">
                <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-green-50">
                  <AlertTriangle className="h-4 w-4 text-green-500" />
                </div>
                <p className="text-xs text-zinc-500">All stock levels are healthy</p>
              </div>
            ) : (
              <div className="divide-y divide-zinc-50">
                {data.lowStock.map((row: InventoryRow) => (
                  <div
                    key={row.variantId}
                    className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-zinc-50 transition-colors"
                    onClick={() => navigate('/inventory')}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-zinc-700">
                        {row.productName}
                      </p>
                      <p className="font-mono text-[10px] text-zinc-400">{row.sku}</p>
                    </div>
                    <div className="ml-3 text-right">
                      <span
                        className={cn(
                          'font-mono text-sm font-semibold',
                          row.status === 'out_of_stock' ? 'text-red-600' : 'text-amber-600'
                        )}
                      >
                        {row.stock}
                      </span>
                      <p className="text-[10px] text-zinc-400">/{row.threshold}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
