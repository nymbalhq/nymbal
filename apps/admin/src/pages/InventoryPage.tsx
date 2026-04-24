import { useState } from 'react'
import { Search, History, Boxes } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { StockAdjustRow } from '@/components/inventory/StockAdjustRow'
import { StockHistoryDrawer } from '@/components/inventory/StockHistoryDrawer'
import { EmptyState } from '@/components/common/EmptyState'
import { useInventory, useAdjustStock } from '@/hooks/useInventory'
import { tid } from '@/lib/testid'
import { cn } from '@/lib/utils'
import type { InventoryRow, InventoryStatus, StockAdjustmentReason } from '@/types'

const STATUS_BADGE: Record<InventoryStatus, 'success' | 'warning' | 'destructive'> = {
  in_stock: 'success',
  low_stock: 'warning',
  out_of_stock: 'destructive',
}

const STATUS_LABEL: Record<InventoryStatus, string> = {
  in_stock: 'In Stock',
  low_stock: 'Low Stock',
  out_of_stock: 'Out of Stock',
}

export function InventoryPage() {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<InventoryStatus | 'all'>('all')
  const [historyRow, setHistoryRow] = useState<InventoryRow | null>(null)

  const { data: inventory, isLoading } = useInventory({
    q: search || undefined,
    status: statusFilter === 'all' ? undefined : statusFilter,
    sort: 'urgency',
    limit: 200,
  })

  const adjustStock = useAdjustStock()

  const handleAdjust = (variantId: string) => (delta: number, reason: StockAdjustmentReason) => {
    void adjustStock.mutateAsync({ variantId, delta, reason })
  }

  const borderColor = (status: InventoryStatus) => {
    if (status === 'out_of_stock') return 'border-l-4 border-l-red-300'
    if (status === 'low_stock') return 'border-l-4 border-l-amber-300'
    return ''
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Inventory</h1>
          <p className="text-sm text-zinc-500">
            {inventory ? `${inventory.length} variants` : 'Loading...'}
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-center">
        <div className="flex gap-1.5">
          {(['all', 'out_of_stock', 'low_stock', 'in_stock'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                statusFilter === s
                  ? 'bg-zinc-900 text-white'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
              )}
            >
              {s === 'all' ? 'All' : STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="relative ml-auto max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
          <Input
            placeholder="Search SKU or product..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-8 text-sm"
          />
        </div>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white overflow-hidden">
        {isLoading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : !inventory?.length ? (
          <EmptyState
            icon={<Boxes className="h-5 w-5" />}
            title="No inventory found"
            description="No variants match your filters."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>SKU / Options</TableHead>
                <TableHead className="text-right">Stock</TableHead>
                <TableHead className="text-right">Threshold</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Adjust</TableHead>
                <TableHead className="text-right">History</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inventory.map((row) => (
                <TableRow
                  key={row.variantId}
                  data-testid={tid('inventory', 'row', row.variantId)}
                  className={cn('transition-colors', borderColor(row.status))}
                >
                  <TableCell>
                    <p className="font-medium text-zinc-800 text-sm">{row.productName}</p>
                  </TableCell>
                  <TableCell>
                    <div>
                      <p className="font-mono text-xs text-zinc-500">{row.sku}</p>
                      {row.options.length > 0 && (
                        <p className="text-[10px] text-zinc-400">
                          {row.options.map((o) => `${o.name}: ${o.value}`).join(' · ')}
                        </p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className={cn(
                    'text-right font-mono text-base font-semibold',
                    row.status === 'out_of_stock' ? 'text-red-600' : row.status === 'low_stock' ? 'text-amber-600' : 'text-zinc-800'
                  )}>
                    {row.stock}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm text-zinc-400">
                    {row.threshold}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE[row.status]} className="text-[10px]">
                      {STATUS_LABEL[row.status]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <StockAdjustRow row={row} onAdjust={handleAdjust(row.variantId)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <button
                      onClick={() => setHistoryRow(row)}
                      className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 font-medium ml-auto"
                    >
                      <History className="h-3.5 w-3.5" />
                      History
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {historyRow && (
        <StockHistoryDrawer
          variantId={historyRow.variantId}
          productName={historyRow.productName}
          sku={historyRow.sku}
          onClose={() => setHistoryRow(null)}
        />
      )}
    </div>
  )
}

export const inventoryHandle = {
  breadcrumb: () => 'Inventory',
}
