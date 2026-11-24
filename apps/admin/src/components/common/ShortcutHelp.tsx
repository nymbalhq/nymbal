import { useRef } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SHORTCUTS } from '@/lib/shortcuts'
import { tid } from '@/lib/testid'

export function ShortcutHelp({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // Opened by a key, not a trigger, so Radix has no element to return focus to; the one focused before it is kept.
  const returnTo = useRef<HTMLElement | null>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={tid('shortcuts', 'help')}
        aria-describedby={undefined}
        onOpenAutoFocus={() => {
          returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(event) => {
          if (returnTo.current?.isConnected) {
            event.preventDefault()
            returnTo.current.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2 text-sm">
          {SHORTCUTS.map((s) => (
            <div key={s.label} className="contents">
              <dt className="flex gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-xs text-zinc-700"
                  >
                    {k}
                  </kbd>
                ))}
              </dt>
              <dd className="text-zinc-600">{s.label}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
