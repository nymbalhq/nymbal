import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { useRefundOrder, usePartialRefundOrder } from '@/hooks/useOrders'
import { formatMoney } from '@/lib/money'
import { tid } from '@/lib/testid'
import type { Order, OrderLineItem } from '@/types'

interface OrderRefundDialogProps {
  order: Order
  onClose: () => void
}

interface LineItemSelection {
  selected: boolean
  qty: number
}

export function OrderRefundDialog({ order, onClose }: OrderRefundDialogProps) {
  const [reason, setReason] = useState('')
  const [lineSelections, setLineSelections] = useState<Record<string, LineItemSelection>>(
    Object.fromEntries(
      order.lineItems.map((item) => [item.variantId, { selected: false, qty: item.qty }])
    )
  )

  const refundMutation = useRefundOrder()
  const partialRefundMutation = usePartialRefundOrder()

  const calculatePartialAmount = () => {
    return order.lineItems.reduce((acc, item) => {
      const sel = lineSelections[item.variantId]
      if (!sel?.selected) return acc
      const qty = Math.min(sel.qty, item.qty)
      return acc + (item.unitPriceMinor * qty)
    }, 0)
  }

  const handleFullRefund = async () => {
    const refundArgs: { orderId: string; amountMinor: number; reason?: string } = {
      orderId: order.id,
      amountMinor: order.totalMinor,
    }
    if (reason) refundArgs.reason = reason
    await refundMutation.mutateAsync(refundArgs)
    onClose()
  }

  const handlePartialRefund = async () => {
    const selectedItems = order.lineItems
      .filter((item) => lineSelections[item.variantId]?.selected)
      .map((item) => ({
        variantId: item.variantId,
        qty: lineSelections[item.variantId]?.qty ?? item.qty,
      }))

    if (selectedItems.length === 0) return

    const partialArgs: { orderId: string; amountMinor: number; reason?: string; lineItems: unknown[] } = {
      orderId: order.id,
      amountMinor: calculatePartialAmount(),
      lineItems: selectedItems,
    }
    if (reason) partialArgs.reason = reason
    await partialRefundMutation.mutateAsync(partialArgs)
    onClose()
  }

  const partialAmount = calculatePartialAmount()
  const hasSelection = Object.values(lineSelections).some((s) => s.selected)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl" data-testid={tid('order', 'refund-dialog')}>
        <DialogHeader>
          <DialogTitle>Refund Order #{order.orderNumber}</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="full">
          <TabsList>
            <TabsTrigger value="full">Full Refund</TabsTrigger>
            <TabsTrigger value="partial">Partial Refund</TabsTrigger>
          </TabsList>

          <TabsContent value="full" className="space-y-4 mt-4">
            <div className="rounded-md border border-zinc-200 p-4 bg-zinc-50">
              <div className="flex items-center justify-between">
                <span className="text-sm text-zinc-600">Total refund amount</span>
                <span className="font-mono text-lg font-semibold text-zinc-900">
                  {formatMoney(order.totalMinor, order.currency)}
                </span>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Reason (optional)</Label>
              <Textarea
                placeholder="Enter refund reason..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handleFullRefund()}
                disabled={refundMutation.isPending}
              >
                {refundMutation.isPending ? 'Processing...' : 'Issue Full Refund'}
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="partial" className="space-y-4 mt-4">
            <div className="rounded-md border border-zinc-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 border-b border-zinc-200">
                  <tr>
                    <th className="w-8 px-3 py-2"></th>
                    <th className="px-3 py-2 text-left text-xs uppercase tracking-wider text-zinc-500 font-medium">Item</th>
                    <th className="px-3 py-2 text-right text-xs uppercase tracking-wider text-zinc-500 font-medium">Qty</th>
                    <th className="px-3 py-2 text-right text-xs uppercase tracking-wider text-zinc-500 font-medium">Unit Price</th>
                    <th className="px-3 py-2 text-right text-xs uppercase tracking-wider text-zinc-500 font-medium">Refund</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lineItems.map((item: OrderLineItem) => {
                    const sel = lineSelections[item.variantId] ?? { selected: false, qty: item.qty }
                    return (
                      <tr key={item.variantId} className="border-b border-zinc-100 last:border-0">
                        <td className="px-3 py-2">
                          <Checkbox
                            checked={sel.selected}
                            onCheckedChange={(checked) => {
                              setLineSelections((prev) => ({
                                ...prev,
                                [item.variantId]: { ...prev[item.variantId] ?? { qty: item.qty }, selected: !!checked },
                              }))
                            }}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <p className="font-medium text-zinc-900">{item.productName}</p>
                          <p className="text-xs text-zinc-500">{item.variantName}</p>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {sel.selected ? (
                            <input
                              type="number"
                              min={1}
                              max={item.qty}
                              value={sel.qty}
                              onChange={(e) => {
                                const v = Math.min(item.qty, Math.max(1, parseInt(e.target.value) || 1))
                                setLineSelections((prev) => ({
                                  ...prev,
                                  [item.variantId]: { ...prev[item.variantId] ?? { selected: true }, qty: v },
                                }))
                              }}
                              className="w-16 rounded border border-zinc-200 px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          ) : (
                            <span className="text-zinc-500">{item.qty}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-sm">
                          {formatMoney(item.unitPriceMinor, order.currency)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-sm font-medium">
                          {sel.selected
                            ? formatMoney(item.unitPriceMinor * sel.qty, order.currency)
                            : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {partialAmount > 0 && (
              <div className="rounded-md border border-zinc-200 p-3 bg-zinc-50">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-zinc-600">Partial refund amount</span>
                  <span className="font-mono text-base font-semibold text-zinc-900">
                    {formatMoney(partialAmount, order.currency)}
                  </span>
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Reason <span className="text-red-500">*</span></Label>
              <Textarea
                placeholder="Reason required for partial refunds..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
              />
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handlePartialRefund()}
                disabled={!hasSelection || !reason.trim() || partialRefundMutation.isPending}
              >
                {partialRefundMutation.isPending ? 'Processing...' : `Refund ${formatMoney(partialAmount, order.currency)}`}
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
