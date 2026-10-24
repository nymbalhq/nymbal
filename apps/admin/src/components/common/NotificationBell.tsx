import { Bell, Info, AlertTriangle, AlertCircle, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useNotifications } from '@/hooks/useNotifications'
import { formatRelative } from '@/lib/dates'
import { cn } from '@/lib/utils'
import type { Notification } from '@/types'

function NotificationIcon({ type }: { type: Notification['type'] }) {
  if (type === 'error') return <AlertCircle className="h-4 w-4 text-red-500" />
  if (type === 'warning') return <AlertTriangle className="h-4 w-4 text-amber-500" />
  return <Info className="h-4 w-4 text-blue-500" />
}

export function NotificationBell() {
  const { notifications, unreadCount, markAllRead } = useNotifications()
  const recent = notifications.slice(0, 10)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Notifications"
          className="relative text-zinc-500 hover:text-zinc-700"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
          <span className="text-sm font-semibold text-zinc-900">Notifications</span>
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium"
            >
              <Check className="h-3 w-3" />
              Mark all read
            </button>
          )}
        </div>
        <div className="max-h-80 overflow-y-auto">
          {recent.length === 0 ? (
            <div className="py-8 text-center text-sm text-zinc-400">
              No notifications
            </div>
          ) : (
            recent.map((n) => (
              <div
                key={n.id}
                className={cn(
                  'flex gap-3 border-b border-zinc-50 px-4 py-3 last:border-0',
                  !n.read && 'bg-blue-50/30'
                )}
              >
                <div className="mt-0.5 shrink-0">
                  <NotificationIcon type={n.type} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-zinc-900">{n.title}</p>
                  <p className="mt-0.5 text-xs text-zinc-500 line-clamp-2">{n.message}</p>
                  <p className="mt-1 text-[10px] text-zinc-400">{formatRelative(n.at)}</p>
                </div>
                {!n.read && (
                  <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" />
                )}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
