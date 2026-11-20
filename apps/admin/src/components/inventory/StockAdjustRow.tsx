import { useRef, useState } from 'react'
import { Plus, Minus, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { ApiError } from '@/lib/api'
import { tid } from '@/lib/testid'
import { useIntentKey } from '@/hooks/useIntentKey'
import type { StockAdjustmentReason } from '@nymbalhq/types'
import type { InventoryRow } from '@/types'

const REASONS: { value: StockAdjustmentReason; label: string }[] = [
  { value: 'manual', label: 'Manual' },
  { value: 'return', label: 'Return' },
  { value: 'import', label: 'Import' },
  { value: 'sale', label: 'Sale' },
  { value: 'reservation-commit', label: 'Reservation' },
  { value: 'reservation-release', label: 'Release' },
]

interface StockAdjustRowProps {
  row: InventoryRow
  /** `idempotencyKey` is this click's. Done shows once the promise resolves; a rejection is shown on the row. */
  onAdjust: (
    delta: number,
    reason: StockAdjustmentReason,
    idempotencyKey: string,
  ) => Promise<unknown>
}

const FALLBACK_ERROR = 'The stock could not be changed.'

export function StockAdjustRow({ row, onAdjust }: StockAdjustRowProps) {
  const [delta, setDelta] = useState(0)
  const [reason, setReason] = useState<StockAdjustmentReason>('manual')
  const [submitted, setSubmitted] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set at the click, so a second click before the re-render that disables Apply sends nothing.
  const inFlight = useRef(false)
  const [intentKey, renewIntentKey] = useIntentKey()

  const handleSubmit = async () => {
    if (delta === 0 || inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError(null)
    renewIntentKey()
    try {
      await onAdjust(delta, reason, intentKey)
    } catch (err) {
      // The delta stays as typed, so the merchant can correct it.
      setError(err instanceof ApiError ? err.message : FALLBACK_ERROR)
      return
    } finally {
      inFlight.current = false
      setPending(false)
    }
    setDelta(0)
    setSubmitted(true)
    setTimeout(() => setSubmitted(false), 1500)
  }

  return (
    <div className="space-y-1">
      <div
        className="flex items-center gap-2"
        data-testid={tid('inventory', 'adjust', row.variantId)}
      >
        {/* Delta input */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setDelta((d) => d - 1)}
            className="flex h-7 w-7 items-center justify-center rounded border border-zinc-200 text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700"
          >
            <Minus className="h-3 w-3" />
          </button>
          <input
            type="number"
            value={delta}
            onChange={(e) => setDelta(parseInt(e.target.value) || 0)}
            className={cn(
              'h-7 w-16 rounded border text-center text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-500',
              delta > 0 && 'border-green-300 text-green-700 bg-green-50',
              delta < 0 && 'border-red-300 text-red-700 bg-red-50',
              delta === 0 && 'border-zinc-200',
            )}
          />
          <button
            onClick={() => setDelta((d) => d + 1)}
            className="flex h-7 w-7 items-center justify-center rounded border border-zinc-200 text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>

        {/* Reason */}
        <Select value={reason} onValueChange={(v) => setReason(v as StockAdjustmentReason)}>
          <SelectTrigger className="h-7 w-28 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REASONS.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Submit */}
        <Button
          size="sm"
          variant={submitted ? 'secondary' : 'default'}
          className="h-7 px-2 text-xs gap-1"
          onClick={() => void handleSubmit()}
          disabled={delta === 0 || submitted || pending}
        >
          {submitted ? (
            <>
              <Check className="h-3 w-3 text-green-600" />
              <span className="text-green-600">Done</span>
            </>
          ) : (
            'Apply'
          )}
        </Button>
      </div>
      {error && (
        <p
          role="alert"
          className="text-xs text-red-600"
          data-testid={tid('inventory', 'adjust', 'error', row.variantId)}
        >
          {error}
        </p>
      )}
    </div>
  )
}
