import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useOrderBulkAction, type OrderBulkOutcome } from '@/hooks/useOrderBulkAction'
import { planOrderBulk, type OrderBulkAction, type OrderBulkPlan } from '@/lib/order-bulk'
import { tid } from '@/lib/testid'
import type { AdminOrder } from '@/types'

const COPY: Record<OrderBulkAction, { title: string; submit: string; move: string }> = {
  cancel: { title: 'Cancel orders', submit: 'Cancel orders', move: 'be cancelled' },
  process: { title: 'Mark processing', submit: 'Mark processing', move: 'move to processing' },
}

const orderWord = (n: number) => (n === 1 ? 'order' : 'orders')

function skipText({ order, reason }: OrderBulkPlan['skipped'][number]): string {
  if (reason === 'paid') return 'Paid: refund it instead'
  if (reason === 'refunded') return 'Fully refunded'
  return `Its status is ${order.status}`
}

function summaryText(action: OrderBulkAction, plan: OrderBulkPlan): string {
  const moving = plan.eligible.length
  const left = plan.skipped.length
  const moves = `${moving} ${orderWord(moving)} will ${COPY[action].move}.`
  return left === 0 ? moves : `${moves} ${left} will be left as ${left === 1 ? 'it is' : 'they are'}.`
}

function resultText({ succeeded, failed }: OrderBulkOutcome): string {
  const changed = `${succeeded.length} ${orderWord(succeeded.length)} changed.`
  return failed.length === 0 ? changed : `${changed} ${failed.length} could not be changed.`
}

interface OrderBulkDialogProps {
  /** The action to confirm, or null when the dialog is closed. */
  action: OrderBulkAction | null
  orders: AdminOrder[]
  /** The run's outcome, or null when the dialog closed before anything was sent. */
  onClose: (outcome: OrderBulkOutcome | null) => void
}

/** Confirms a bulk action, runs it and reports which orders changed. */
export function OrderBulkDialog({ action, orders, onClose }: OrderBulkDialogProps) {
  if (action === null) return null
  return <OpenOrderBulkDialog action={action} orders={orders} onClose={onClose} />
}

function OpenOrderBulkDialog({
  action,
  orders,
  onClose,
}: OrderBulkDialogProps & { action: OrderBulkAction }) {
  // Planned once on open: the list refetches under the dialog, and the merchant confirmed these counts.
  const [plan] = useState(() => planOrderBulk(action, orders))
  const [sent, setSent] = useState(false)
  const [outcome, setOutcome] = useState<OrderBulkOutcome | null>(null)
  const { run, progress } = useOrderBulkAction()

  const midRun = sent && outcome === null
  const total = plan.eligible.length

  const submit = () => {
    if (sent || total === 0) return
    setSent(true)
    void run(action, plan.eligible).then(setOutcome)
  }

  const close = () => {
    if (!midRun) onClose(outcome)
  }

  let status = { id: 'summary', text: summaryText(action, plan) }
  if (midRun) status = { id: 'progress', text: `${progress?.done ?? 0} of ${total}` }
  if (outcome !== null) status = { id: 'result', text: resultText(outcome) }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md" data-testid={tid('orders', 'bulk', 'dialog')}>
        <DialogHeader>
          <DialogTitle>{COPY[action].title}</DialogTitle>
          <DialogDescription data-testid={tid('orders', 'bulk', status.id)}>
            {status.text}
          </DialogDescription>
        </DialogHeader>

        {outcome === null && plan.skipped.length > 0 && (
          <ul className="max-h-48 space-y-1 overflow-y-auto text-sm text-zinc-600">
            {plan.skipped.map((skip) => (
              <li
                key={skip.order.id}
                data-testid={tid('orders', 'bulk', 'skipped', skip.order.orderNumber)}
              >
                <span className="font-mono">#{skip.order.orderNumber}</span>: {skipText(skip)}
              </li>
            ))}
          </ul>
        )}

        {outcome !== null && outcome.failed.length > 0 && (
          <ul className="max-h-48 space-y-1 overflow-y-auto text-sm text-red-600">
            {outcome.failed.map((failure) => (
              <li
                key={failure.orderId}
                data-testid={tid('orders', 'bulk', 'failed', failure.orderNumber)}
              >
                <span className="font-mono">#{failure.orderNumber}</span>: {failure.message}
              </li>
            ))}
          </ul>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={close}
            disabled={midRun}
            data-testid={tid('orders', 'bulk', 'dismiss')}
          >
            Close
          </Button>
          {outcome === null && (
            <Button
              variant={action === 'cancel' ? 'destructive' : 'default'}
              onClick={submit}
              disabled={sent || total === 0}
              data-testid={tid('orders', 'bulk', 'submit')}
            >
              {COPY[action].submit}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
