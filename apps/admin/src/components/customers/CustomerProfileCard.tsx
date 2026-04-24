import { Mail, Phone, Calendar, ShoppingBag, TrendingUp } from 'lucide-react'
import { formatMoney } from '@/lib/money'
import { formatDate, formatRelative } from '@/lib/dates'
import type { Customer, CustomerStats } from '@/types'

interface CustomerProfileCardProps {
  customer: Customer
  stats: CustomerStats
}

export function CustomerProfileCard({ customer, stats }: CustomerProfileCardProps) {
  const fullName = [customer.firstName, customer.lastName].filter(Boolean).join(' ') || customer.email

  return (
    <div className="space-y-4">
      {/* Profile header */}
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-lg font-semibold text-zinc-600">
          {(customer.firstName?.[0] ?? customer.email[0] ?? '?').toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-zinc-900 truncate">{fullName}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-zinc-500">
            <span className="flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              {customer.email}
            </span>
            {customer.phone && (
              <span className="flex items-center gap-1.5">
                <Phone className="h-3.5 w-3.5" />
                {customer.phone}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-400">
            <Calendar className="h-3 w-3" />
            Customer since {formatDate(customer.createdAt)}
          </div>
        </div>
        {customer.requiresPasswordReset && (
          <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700">
            Needs reset
          </span>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard
          icon={<ShoppingBag className="h-4 w-4 text-blue-500" />}
          label="Total Orders"
          value={String(stats.orderCount)}
        />
        <StatCard
          icon={<TrendingUp className="h-4 w-4 text-green-500" />}
          label="Lifetime Value"
          value={formatMoney(stats.lifetimeRevenueMinor, 'GBP')}
          mono
        />
        <StatCard
          icon={<TrendingUp className="h-4 w-4 text-indigo-500" />}
          label="Avg Order"
          value={formatMoney(stats.avgOrderValueMinor, 'GBP')}
          mono
        />
      </div>

      {stats.lastOrderAt && (
        <p className="text-xs text-zinc-400">
          Last order: {formatRelative(stats.lastOrderAt)}
        </p>
      )}
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  mono,
}: {
  icon: React.ReactNode
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-3">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs text-zinc-500">{label}</span>
      </div>
      <p className={`text-base font-semibold text-zinc-900 ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  )
}
