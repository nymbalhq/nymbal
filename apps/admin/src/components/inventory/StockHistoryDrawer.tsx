import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { useInventoryHistory } from '@/hooks/useInventory'
import { formatDate } from '@/lib/dates'
import { cn } from '@/lib/utils'

interface StockHistoryDrawerProps {
  variantId: string
  productName: string
  sku: string
  onClose: () => void
}

export function StockHistoryDrawer({ variantId, productName, sku, onClose }: StockHistoryDrawerProps) {
  const { data: history, isLoading } = useInventoryHistory(variantId)

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-[480px] sm:max-w-[480px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Stock History</SheetTitle>
          <div className="mt-1">
            <p className="text-sm font-medium text-zinc-700">{productName}</p>
            <p className="font-mono text-xs text-zinc-400">{sku}</p>
          </div>
        </SheetHeader>

        <div className="mt-6">
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !history || history.length === 0 ? (
            <p className="text-sm text-zinc-400 text-center py-8">No adjustment history found.</p>
          ) : (
            <div className="rounded-md border border-zinc-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 border-b border-zinc-200">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">Date</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-zinc-500">Adj</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-zinc-500">New Qty</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">Reason</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-zinc-500">Actor</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((entry) => (
                    <tr key={entry.id} className="border-b border-zinc-100 last:border-0">
                      <td className="px-3 py-2 text-xs text-zinc-500 whitespace-nowrap">
                        {formatDate(entry.timestamp)}
                      </td>
                      <td className={cn(
                        'px-3 py-2 text-right font-mono text-sm font-medium',
                        entry.adjustment > 0 ? 'text-green-600' : 'text-red-600'
                      )}>
                        {entry.adjustment > 0 ? '+' : ''}{entry.adjustment}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-sm text-zinc-700">
                        {entry.newQty}
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-500 capitalize">
                        {entry.reason.replace(/-/g, ' ')}
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-500">
                        {entry.actor}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
