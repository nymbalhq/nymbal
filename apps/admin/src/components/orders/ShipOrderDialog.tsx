import { useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useShipOrder } from '@/hooks/useOrders'
import { ApiError } from '@/lib/api'
import { tid } from '@/lib/testid'

interface ShipOrderDialogProps {
  orderId: string
  orderNumber: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Ships an order: the API refuses a blank carrier or tracking number, so both are asked for here. */
export function ShipOrderDialog({
  orderId,
  orderNumber,
  open,
  onOpenChange,
}: ShipOrderDialogProps) {
  const [carrier, setCarrier] = useState('')
  const [trackingNumber, setTrackingNumber] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  // Set in the click itself: `isPending` reaches the button only after a render, too late for a double click.
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  const shipOrder = useShipOrder()

  // A refusal belongs to the attempt that drew it, not to the next opening.
  useEffect(() => {
    if (open) setFailure(null)
  }, [open])

  const valid = carrier.trim() !== '' && trackingNumber.trim() !== ''

  const close = () => {
    setCarrier('')
    setTrackingNumber('')
    setFailure(null)
    onOpenChange(false)
  }

  const handleShip = async () => {
    if (!valid || submitting.current) return
    submitting.current = true
    setBusy(true)
    setFailure(null)
    try {
      await shipOrder.mutateAsync({
        orderId,
        carrier: carrier.trim(),
        trackingNumber: trackingNumber.trim(),
      })
      close()
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : 'The order could not be shipped.')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-md" data-testid={tid('order', 'ship-dialog')}>
        <DialogHeader>
          <DialogTitle>Ship Order #{orderNumber}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ship-carrier">Carrier</Label>
            <Input
              id="ship-carrier"
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
              data-testid={tid('order', 'ship-carrier')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ship-tracking">Tracking number</Label>
            <Input
              id="ship-tracking"
              value={trackingNumber}
              onChange={(e) => setTrackingNumber(e.target.value)}
              data-testid={tid('order', 'ship-tracking')}
            />
          </div>
          {failure && (
            <p
              role="alert"
              className="text-sm text-red-600"
              data-testid={tid('order', 'ship-error')}
            >
              {failure}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={close}
            data-testid={tid('order', 'ship-cancel')}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleShip()}
            disabled={!valid || busy}
            data-testid={tid('order', 'ship-submit')}
          >
            {busy ? 'Shipping...' : 'Ship order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
