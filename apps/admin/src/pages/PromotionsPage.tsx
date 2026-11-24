import { useState, type FormEvent } from 'react'
import { Plus, Tag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/common/EmptyState'
import { useStoreCurrency } from '@/hooks/useMe'
import {
  useCreatePromotion,
  useDeletePromotion,
  usePromotions,
  useUpdatePromotion,
  type PromotionFields,
} from '@/hooks/usePromotions'
import { ApiError } from '@/lib/api'
import { formatDate } from '@/lib/dates'
import { firstClick } from '@/lib/first-click'
import { formatMoney, parseMoney, toMoneyInput } from '@/lib/money'
import { parsePercentBps, toPercentInput } from '@/lib/percent'
import { promotionState, type PromotionState } from '@/lib/promotion-state'
import { tid } from '@/lib/testid'
import type { AdminPromotion } from '@/types'

const STATE_LABEL: Record<PromotionState, string> = {
  active: 'Active',
  inactive: 'Inactive',
  expired: 'Expired',
  'used-up': 'Used up',
}

const STATE_CLASS: Record<PromotionState, string> = {
  active: 'text-emerald-700',
  inactive: 'text-zinc-500',
  expired: 'text-amber-700',
  'used-up': 'text-amber-700',
}

const two = (n: number) => String(n).padStart(2, '0')

/** An instant as a `datetime-local` value in the browser's zone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`
}

function discountOf(p: AdminPromotion, storeCurrency: string): string {
  if (p.kind === 'percent') return `${toPercentInput(p.percentBps ?? 0)}%`
  return `${formatMoney(p.amountOffMinor ?? 0, p.currency ?? storeCurrency)} off`
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback
}

interface FormValues {
  code: string
  kind: 'percent' | 'fixed'
  value: string
  minimum: string
  expires: string
  cap: string
  active: boolean
}

function formOf(p: AdminPromotion | null, currency: string): FormValues {
  if (p === null) {
    return { code: '', kind: 'percent', value: '', minimum: '', expires: '', cap: '', active: true }
  }
  return {
    code: p.code,
    kind: p.kind,
    value:
      p.kind === 'percent'
        ? toPercentInput(p.percentBps ?? 0)
        : toMoneyInput(p.amountOffMinor ?? 0, currency),
    minimum: p.minimumSubtotalMinor === null ? '' : toMoneyInput(p.minimumSubtotalMinor, currency),
    expires: p.expiresAt === null ? '' : toLocalInput(p.expiresAt),
    cap: p.usageCap === null ? '' : String(p.usageCap),
    active: p.active,
  }
}

/** The fields the form's text spells, or the sentence for the first value it cannot read. */
function fieldsOf(form: FormValues, currency: string): PromotionFields | string {
  const amountRefusal = `Enter an amount in ${currency}.`
  let percentBps: number | null = null
  let amountOffMinor: number | null = null
  if (form.kind === 'percent') {
    percentBps = parsePercentBps(form.value)
    if (percentBps === null) return 'Enter a percent between 0.01 and 99.99.'
  } else {
    amountOffMinor = parseMoney(form.value, currency)
    if (amountOffMinor === null || amountOffMinor === 0) return amountRefusal
  }
  let minimumSubtotalMinor: number | null = null
  if (form.minimum.trim() !== '') {
    minimumSubtotalMinor = parseMoney(form.minimum, currency)
    if (minimumSubtotalMinor === null) return amountRefusal
  }
  let usageCap: number | null = null
  if (form.cap.trim() !== '') {
    const cap = form.cap.trim()
    if (!/^\d+$/.test(cap) || Number(cap) < 1) return 'Enter a whole number of uses, 1 or more.'
    usageCap = Number(cap)
  }
  return {
    code: form.code.trim(),
    kind: form.kind,
    percentBps,
    amountOffMinor,
    // The server needs a currency for a fixed amount and for a minimum; it is always the store's.
    currency: form.kind === 'fixed' || minimumSubtotalMinor !== null ? currency : null,
    minimumSubtotalMinor,
    expiresAt: form.expires === '' ? null : new Date(form.expires).toISOString(),
    usageCap,
    active: form.active,
  }
}

interface PromotionDialogProps {
  editing: AdminPromotion | null
  currency: string
  saving: boolean
  /** Sends the fields; null when a save of this code is already open. */
  onSave: (fields: PromotionFields) => Promise<unknown> | null
  onSaved: (code: string) => void
  onClose: () => void
}

function PromotionDialog({
  editing,
  currency,
  saving,
  onSave,
  onSaved,
  onClose,
}: PromotionDialogProps) {
  const [form, setForm] = useState(() => formOf(editing, currency))
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const fields = fieldsOf(form, currency)
    if (typeof fields === 'string') {
      setError(fields)
      return
    }
    const sent = onSave(fields)
    if (sent === null) return
    setError(null)
    try {
      await sent
      onSaved(fields.code)
    } catch (err) {
      setError(errorText(err, 'The promotion could not be saved.'))
    }
  }

  return (
    // While a save is open the dialog stays: its answer, a refusal included, is said here.
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-w-md" data-testid={tid('promotion', 'dialog')}>
        <DialogHeader>
          <DialogTitle className="break-all leading-snug">
            {editing === null ? 'New promotion' : `Edit ${editing.code}`}
          </DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(e) => void submit(e)} noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="promotion-code">Code</Label>
            <Input
              id="promotion-code"
              value={form.code}
              onChange={(e) => set('code', e.target.value)}
              autoComplete="off"
              data-testid={tid('promotion', 'code')}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="promotion-kind">Discount</Label>
              <select
                id="promotion-kind"
                value={form.kind}
                onChange={(e) => set('kind', e.target.value as FormValues['kind'])}
                className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm"
                data-testid={tid('promotion', 'kind')}
              >
                <option value="percent">Percent</option>
                <option value="fixed">Fixed amount</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="promotion-value">
                {form.kind === 'percent' ? 'Percent off' : `Amount off (${currency})`}
              </Label>
              <Input
                id="promotion-value"
                inputMode="decimal"
                value={form.value}
                onChange={(e) => set('value', e.target.value)}
                data-testid={tid('promotion', 'value')}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="promotion-minimum">Minimum subtotal ({currency}, optional)</Label>
            <Input
              id="promotion-minimum"
              inputMode="decimal"
              value={form.minimum}
              onChange={(e) => set('minimum', e.target.value)}
              data-testid={tid('promotion', 'minimum')}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="promotion-expires">Expires (optional)</Label>
              <Input
                id="promotion-expires"
                type="datetime-local"
                value={form.expires}
                onChange={(e) => set('expires', e.target.value)}
                data-testid={tid('promotion', 'expires')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="promotion-cap">Uses allowed (optional)</Label>
              <Input
                id="promotion-cap"
                inputMode="numeric"
                value={form.cap}
                onChange={(e) => set('cap', e.target.value)}
                data-testid={tid('promotion', 'cap')}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => set('active', e.target.checked)}
              data-testid={tid('promotion', 'active')}
            />
            Active
          </label>
          {error !== null && (
            <p
              role="alert"
              className="text-sm text-red-600"
              data-testid={tid('promotion', 'error')}
            >
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" type="button" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving}
              onClick={firstClick()}
              data-testid={tid('promotion', 'save')}
            >
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The store's discount codes: what each gives, how often it was used, and whether a cart accepts it now. */
export function PromotionsPage() {
  const currency = useStoreCurrency()
  const { data: promotions, isLoading, isError } = usePromotions()
  const { create, creating } = useCreatePromotion()
  const { update, updating } = useUpdatePromotion()
  const { remove, deleting } = useDeletePromotion()
  // null: closed; 'new'; or the promotion being edited.
  const [dialog, setDialog] = useState<AdminPromotion | 'new' | null>(null)
  const [confirming, setConfirming] = useState<AdminPromotion | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const report = async (sent: Promise<unknown> | null, done: string, failed: string) => {
    if (sent === null) return
    // The last outcome stays until this one is known: clearing it now would move the table under a second click.
    try {
      await sent
      setError(null)
      setResult(done)
    } catch (err) {
      setResult(null)
      setError(errorText(err, failed))
    }
  }

  const toggle = (p: AdminPromotion) =>
    void report(
      update(p.id, { active: !p.active }),
      `${p.active ? 'Switched off' : 'Switched on'} ${p.code}`,
      'The promotion could not be changed.',
    )

  const confirmDelete = (p: AdminPromotion) => {
    const sent = remove(p.id)
    setConfirming(null)
    void report(sent, `Deleted ${p.code}`, 'The promotion could not be deleted.')
  }

  const editing = dialog === 'new' ? null : dialog
  const now = new Date()

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Promotions</h1>
          <p className="text-sm text-zinc-500">Discount codes shoppers enter in their cart.</p>
        </div>
        <Button
          disabled={currency === undefined}
          onClick={firstClick(() => {
            setResult(null)
            setError(null)
            setDialog('new')
          })}
          data-testid={tid('promotions', 'new')}
        >
          <Plus className="mr-1 h-4 w-4" />
          New promotion
        </Button>
      </div>

      {/* One line kept whether or not there is an outcome, so the rows never move under the pointer. */}
      <div className="min-h-5">
        {result !== null && (
          <p
            role="status"
            className="text-sm text-zinc-600"
            data-testid={tid('promotions', 'result')}
          >
            {result}
          </p>
        )}
        {error !== null && (
          <p role="alert" className="text-sm text-red-600" data-testid={tid('promotions', 'error')}>
            {error}
          </p>
        )}
      </div>

      <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-200 bg-white">
        {isLoading || currency === undefined ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : isError ? (
          <EmptyState
            icon={<Tag className="h-5 w-5" />}
            title="The promotions could not be loaded"
          />
        ) : !promotions || promotions.length === 0 ? (
          <EmptyState icon={<Tag className="h-5 w-5" />} title="No promotions yet." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Discount</TableHead>
                <TableHead>Minimum</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Uses</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {promotions.map((p) => {
                const state = promotionState(p, now)
                const busy = updating.has(p.id) || deleting.has(p.id)
                return (
                  <TableRow key={p.id} data-testid={tid('promotions', 'row', p.id)}>
                    <TableCell className="font-mono text-sm font-medium text-zinc-900">
                      {p.code}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{discountOf(p, currency)}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {p.minimumSubtotalMinor === null
                        ? 'None'
                        : formatMoney(p.minimumSubtotalMinor, p.currency ?? currency)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {p.expiresAt === null ? 'Never' : formatDate(p.expiresAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {p.usageCap === null
                        ? String(p.usedCount)
                        : `${p.usedCount} of ${p.usageCap}`}
                    </TableCell>
                    <TableCell
                      className={`whitespace-nowrap font-medium ${STATE_CLASS[state]}`}
                      data-testid={tid('promotions', 'state', p.id)}
                    >
                      {STATE_LABEL[state]}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={firstClick(() => toggle(p))}
                          data-testid={tid('promotions', 'toggle', p.id)}
                        >
                          {p.active ? 'Switch off' : 'Switch on'}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={firstClick(() => {
                            setResult(null)
                            setError(null)
                            setDialog(p)
                          })}
                          data-testid={tid('promotions', 'edit', p.id)}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={firstClick(() => setConfirming(p))}
                          data-testid={tid('promotions', 'delete', p.id)}
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {dialog !== null && currency !== undefined && (
        <PromotionDialog
          editing={editing}
          currency={currency}
          saving={editing === null ? creating : updating.has(editing.id)}
          onSave={(fields) => (editing === null ? create(fields) : update(editing.id, fields))}
          onSaved={(code) => {
            setDialog(null)
            setResult(`${editing === null ? 'Created' : 'Saved'} ${code}`)
          }}
          onClose={() => setDialog(null)}
        />
      )}

      {confirming !== null && (
        <Dialog open onOpenChange={(open) => !open && setConfirming(null)}>
          <DialogContent className="max-w-sm" data-testid={tid('promotion', 'delete-dialog')}>
            <DialogHeader>
              <DialogTitle className="break-all leading-snug">
                Delete {confirming.code}?
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-zinc-600">
              A code an order has used cannot be deleted; switch it off instead.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={firstClick(() => confirmDelete(confirming))}
                data-testid={tid('promotion', 'delete-confirm')}
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

export const promotionsHandle = { breadcrumb: () => 'Promotions' }
