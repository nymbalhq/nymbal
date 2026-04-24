import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Users } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { useCustomers } from '@/hooks/useCustomers'
import { formatMoney } from '@/lib/money'
import { formatDate, formatRelative } from '@/lib/dates'
import { tid } from '@/lib/testid'

export function CustomersListPage() {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')

  const { data: customers, isLoading } = useCustomers({
    q: search || undefined,
    limit: 100,
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Customers</h1>
          <p className="text-sm text-zinc-500">
            {customers ? `${customers.length} customers` : 'Loading...'}
          </p>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
        <Input
          placeholder="Search by name or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 h-8 text-sm"
        />
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white overflow-hidden">
        {isLoading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : !customers?.length ? (
          <EmptyState
            icon={<Users className="h-5 w-5" />}
            title="No customers found"
            description={search ? 'Try a different search.' : 'Customers will appear as orders are placed.'}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Orders</TableHead>
                <TableHead className="text-right">Total Spent</TableHead>
                <TableHead>Since</TableHead>
                <TableHead className="text-right">Last Order</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {customers.map((customer) => {
                const fullName = [customer.firstName, customer.lastName].filter(Boolean).join(' ')
                return (
                  <TableRow
                    key={customer.id}
                    data-testid={tid('customers', 'row', customer.id)}
                    className="cursor-pointer"
                    onClick={() => navigate(`/admin/customers/${customer.id}`)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600">
                          {(customer.firstName?.[0] ?? customer.email[0] ?? '?').toUpperCase()}
                        </div>
                        <div>
                          {fullName && <p className="text-sm font-medium text-zinc-800">{fullName}</p>}
                          <p className="text-xs text-zinc-500">{customer.email}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-zinc-700">
                      {customer.orderCount}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-zinc-700">
                      {formatMoney(customer.totalSpentMinor, 'GBP')}
                    </TableCell>
                    <TableCell className="text-sm text-zinc-500">
                      {formatDate(customer.createdAt)}
                    </TableCell>
                    <TableCell className="text-right text-sm text-zinc-400">
                      {customer.orderCount > 0 ? formatRelative(customer.updatedAt) : '—'}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

export const customersListHandle = {
  breadcrumb: () => 'Customers',
}
