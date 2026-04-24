import { useEffect, useRef } from 'react'
import { Breadcrumbs } from '@/components/layout/Breadcrumbs'
import { NotificationBell } from '@/components/common/NotificationBell'
import { CommandPaletteButton, CommandPalette } from '@/components/common/CommandPalette'
import { useEventTicker } from '@/realtime/handlers'
import { cn } from '@/lib/utils'

function EventTypeColor(type: string): string {
  if (type.includes('error') || type.includes('failed') || type.includes('out_of_stock'))
    return 'bg-red-500/10 text-red-500 border-red-500/20'
  if (type.includes('low_stock') || type.includes('warning'))
    return 'bg-amber-500/10 text-amber-600 border-amber-500/20'
  if (type.includes('placed') || type.includes('paid'))
    return 'bg-green-500/10 text-green-600 border-green-500/20'
  return 'bg-zinc-100 text-zinc-600 border-zinc-200'
}

function LiveTicker() {
  const events = useEventTicker((s) => s.events)
  const tickerRef = useRef<HTMLDivElement>(null)
  const recent = events.slice(0, 3)

  // Auto-scroll animation trigger on new events
  useEffect(() => {
    if (tickerRef.current && events.length > 0) {
      tickerRef.current.scrollLeft = 0
    }
  }, [events.length])

  if (recent.length === 0) {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <span className="flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
          </span>
          <span className="font-medium text-[10px] uppercase tracking-wider text-zinc-400">
            Live
          </span>
        </span>
        <span className="text-zinc-300">—</span>
        <span className="text-zinc-400">No recent events</span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 overflow-hidden" ref={tickerRef}>
      <span className="flex items-center gap-1.5 shrink-0">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
        </span>
        <span className="font-medium text-[10px] uppercase tracking-wider text-zinc-400 shrink-0">
          Live
        </span>
      </span>
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-none">
        {recent.map((event) => (
          <span
            key={event.id}
            className={cn(
              'flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap',
              EventTypeColor(event.type)
            )}
          >
            {event.label}
          </span>
        ))}
      </div>
    </div>
  )
}

export function TopBar() {
  return (
    <>
      <header className="fixed left-60 right-0 top-0 z-30 flex h-14 items-center border-b border-zinc-200 bg-white px-5">
        {/* Left: breadcrumbs */}
        <div className="flex min-w-0 flex-1 items-center">
          <Breadcrumbs />
        </div>

        {/* Center: live ticker */}
        <div className="mx-8 flex flex-1 items-center justify-center overflow-hidden">
          <LiveTicker />
        </div>

        {/* Right: actions */}
        <div className="flex shrink-0 items-center gap-2">
          <CommandPaletteButton />
          <NotificationBell />
        </div>
      </header>
      <CommandPalette />
    </>
  )
}
