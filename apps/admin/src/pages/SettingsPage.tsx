import { useRef, useState } from 'react'
import { KeyRound } from 'lucide-react'
import type { SettingFieldView, SettingsSlotView } from '@nymbalhq/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { useClearSetting, useSaveSetting, useSettings } from '@/hooks/useSettings'
import { ApiError } from '@/lib/api'

const SLOT_LABELS: Record<string, string> = {
  payments: 'Payments',
  email: 'Email',
  reviews: 'Reviews',
  search: 'Search',
  analytics: 'Analytics',
  shipping: 'Shipping',
  tax: 'Tax',
  ai: 'AI',
}

const fieldId = (slot: string, path: string) => `${slot}-${path}`

/** What the field holds, as the page may show it: a secret only as set or not, never its value. */
function stateText(field: SettingFieldView): string {
  if (field.source === 'config' || field.source === 'env') return 'Set by environment'
  if (field.secret) return field.state === 'set' ? 'Set' : 'Not set'
  return field.state === 'set' ? String(field.value ?? '') : 'Not set'
}

interface FieldRowProps {
  slot: string
  field: SettingFieldView
  onSaved: () => void
}

function FieldRow({ slot, field, onSaved }: FieldRowProps) {
  // Uncontrolled, so a typed secret is never mirrored into a value attribute of the page.
  const input = useRef<HTMLInputElement>(null)
  const save = useSaveSetting()
  const clear = useClearSetting()
  const [error, setError] = useState<string | null>(null)
  const id = fieldId(slot, field.path)
  const fromEnvironment = field.source === 'config' || field.source === 'env'

  const handleSave = async () => {
    const value = input.current?.value ?? ''
    if (value === '') return
    setError(null)
    try {
      await save.mutateAsync({ slot, path: field.path, value })
      if (input.current) input.current.value = ''
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The value was not saved')
    }
  }

  const handleClear = async () => {
    setError(null)
    try {
      await clear.mutateAsync({ slot, path: field.path })
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The value was not cleared')
    }
  }

  return (
    <div
      data-testid={`settings-field-${id}`}
      className="flex flex-col gap-2 border-b border-zinc-100 py-3 last:border-b-0 sm:flex-row sm:items-center"
    >
      <div className="min-w-0 sm:w-56">
        <label htmlFor={`settings-input-${id}`} className="text-sm font-medium text-zinc-900">
          {field.label}
        </label>
        <p className="font-mono text-[11px] text-zinc-500">{field.path}</p>
      </div>
      <span
        data-testid={`settings-state-${id}`}
        className="min-w-0 truncate text-sm text-zinc-600 sm:w-44"
      >
        {stateText(field)}
      </span>
      {!fromEnvironment && (
        <div className="flex flex-1 flex-col gap-1">
          <div className="flex gap-2">
            <Input
              ref={input}
              id={`settings-input-${id}`}
              data-testid={`settings-input-${id}`}
              type={field.secret ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              placeholder={field.secret && field.state === 'set' ? 'Enter a new value' : ''}
            />
            <Button
              type="button"
              size="sm"
              className="h-9"
              data-testid={`settings-save-${id}`}
              disabled={save.isPending}
              onClick={() => void handleSave()}
            >
              Save
            </Button>
            {field.source === 'settings' && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-9"
                data-testid={`settings-clear-${id}`}
                disabled={clear.isPending}
                onClick={() => void handleClear()}
              >
                Clear
              </Button>
            )}
          </div>
          {error !== null && (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function SlotSection({ slot, onSaved }: { slot: SettingsSlotView; onSaved: () => void }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white px-4">
      <header className="flex items-baseline gap-2 border-b border-zinc-100 py-3">
        <h2 className="text-sm font-semibold text-zinc-900">
          {SLOT_LABELS[slot.slot] ?? slot.slot}
        </h2>
        <span className="text-xs text-zinc-500">{slot.provider}</span>
      </header>
      {slot.fields.map((field) => (
        <FieldRow key={field.path} slot={slot.slot} field={field} onSaved={onSaved} />
      ))}
    </section>
  )
}

/**
 * The credentials the config leaves unset, for each slot whose provider declares them. A saved secret is shown only
 * as set; a field the config or environment sets is read-only here. Changes apply when the store restarts.
 */
export function SettingsPage() {
  const { data, isLoading } = useSettings()
  const [saved, setSaved] = useState(false)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900">Settings</h1>
        <p className="text-sm text-zinc-500">
          Keys and credentials for the services this store uses. The config and environment always
          win.
        </p>
      </div>
      {saved && (
        <p
          data-testid="settings-restart-note"
          role="status"
          className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800"
        >
          Saved. Restart the store to apply.
        </p>
      )}
      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : data === undefined || data.slots.length === 0 ? (
        <EmptyState
          icon={<KeyRound className="h-5 w-5" />}
          title="Nothing to set here"
          description="None of this store's providers takes keys from Settings."
        />
      ) : (
        data.slots.map((slot) => (
          <SlotSection key={slot.slot} slot={slot} onSaved={() => setSaved(true)} />
        ))
      )}
    </div>
  )
}

export const settingsHandle = {
  breadcrumb: () => 'Settings',
}
