import { useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { useRefundOrder } from '@/hooks/useOrders'
import { ApiError } from '@/lib/api'
import { formatMoney, parseMoney } from '@/lib/money'
import { tid } from '@/lib/testid'
import type { AdminOrder } from '@/types'

interface OrderRefundDialogProps {
  order: AdminOrder
  onClose: () => void
}

/** Why the server refused a refund, its amounts in the store's currency. */
function refusalOf(err: unknown, currency: string): string {
  if (!(err instanceof ApiError)) return 'The refund could not be made.'
  const { amountMinor, refundableMinor } = err.context ?? {}
  if (
    err.code === 'refund.exceeds_captured' &&
    typeof amountMinor === 'number' &&
    typeof refundableMinor === 'number'
  ) {
    return `A refund of ${formatMoney(amountMinor, currency)} is more than the ${formatMoney(refundableMinor, currency)} left to refund.`
  }
  return err.message
}

/** A refund by amount: anything up to what is refundable, the whole of it being a full refund. */
export function OrderRefundDialog({ order, onClose }: OrderRefundDialogProps) {
  const { refundableMinor, currency } = order.payment
  const [amount, setAmount] = useState((refundableMinor / 100).toFixed(2))
  const [reason, setReason] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  // One refund request per dialog: a repeat of it (a double click, a retry after a lost answer) refunds once.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  // Set in the click itself: `isPending` reaches the button only after a render, too late for a double click.
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const refundMutation = useRefundOrder()

  const amountMinor = parseMoney(amount)
  const valid = amountMinor !== null && amountMinor > 0 && amountMinor <= refundableMinor

  const handleRefund = async () => {
    if (!valid || amountMinor === null || submitting.current) return
    submitting.current = true
    setBusy(true)
    setFailure(null)
    try {
      const answer = await refundMutation.mutateAsync({
        orderId: order.id,
        amountMinor,
        requestId,
        ...(reason.trim() && { reason: reason.trim() }),
      })
      if (answer.refund.status === 'failed') {
        // That request is answered: trying again is a new one.
        setRequestId(crypto.randomUUID())
        setFailure('The payment provider refused the refund.')
        return
      }
      onClose()
    } catch (err) {
      setFailure(refusalOf(err, currency))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md" data-testid={tid('order', 'refund-dialog')}>
        <DialogHeader>
          <DialogTitle>Refund Order #{order.orderNumber}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-zinc-200 p-3 bg-zinc-50">
            <div className="flex items-center justify-between text-sm">
              <span className="text-zinc-600">Refundable</span>
              <span className="font-mono font-semibold text-zinc-900">
                {formatMoney(refundableMinor, currency)}
              </span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refund-amount">Amount ({currency})</Label>
            <div className="flex gap-2">
              <Input
                id="refund-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={!valid}
                data-testid={tid('order', 'refund-amount')}
              />
              <Button
                variant="outline"
                type="button"
                onClick={() => setAmount((refundableMinor / 100).toFixed(2))}
              >
                Full refund
              </Button>
            </div>
            {!valid && (
              <p className="text-xs text-red-600">
                Enter an amount above 0 and up to {formatMoney(refundableMinor, currency)}.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refund-reason">Reason (optional)</Label>
            <Textarea
              id="refund-reason"
              placeholder="Enter refund reason..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              data-testid={tid('order', 'refund-reason')}
            />
          </div>
          {failure && (
            <p role="alert" className="text-sm text-red-600">
              {failure}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            type="button"
            onClick={() => void handleRefund()}
            disabled={!valid || busy}
            data-testid={tid('order', 'refund-confirm')}
          >
            {busy
              ? 'Processing...'
              : `Refund ${amountMinor !== null ? formatMoney(amountMinor, currency) : ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
