import { NavLink, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard,
  ShoppingBag,
  Package,
  Boxes,
  Users,
  LogOut,
  Loader2,
} from 'lucide-react'
import { useMe } from '@/hooks/useMe'
import { useAuth } from '@/hooks/useAuth'
import { useOrders } from '@/hooks/useOrders'
import { cn } from '@/lib/utils'

const navItems = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/admin/orders', label: 'Orders', icon: ShoppingBag, end: false },
  { to: '/admin/products', label: 'Products', icon: Package, end: false },
  { to: '/admin/inventory', label: 'Inventory', icon: Boxes, end: false },
  { to: '/admin/customers', label: 'Customers', icon: Users, end: false },
]

function PendingOrdersBadge() {
  const { data: orders } = useOrders({ status: 'pending', limit: 1 })
  // We'd need a count endpoint; for now show a dot if any pending
  if (!orders || orders.length === 0) return null
  return (
    <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500/20 px-1 text-[10px] font-semibold text-blue-400">
      {orders.length}
    </span>
  )
}

export function Sidebar() {
  const { data: me } = useMe()
  const { logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/admin/login')
  }

  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-60 flex-col bg-zinc-950">
      {/* Logo */}
      <div className="flex h-14 items-center border-b border-zinc-800/60 px-4">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-blue-600">
            <span className="text-xs font-bold text-white">N</span>
          </div>
          <span className="text-sm font-bold tracking-widest text-zinc-100 uppercase">
            Nymbal
          </span>
        </div>
        {me?.storeName && (
          <span className="ml-2 truncate text-[10px] font-medium text-zinc-500 border-l border-zinc-700 pl-2">
            {me.storeName}
          </span>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2">
        <ul className="space-y-0.5">
          {navItems.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-all duration-100',
                    isActive
                      ? 'border-l-2 border-blue-500 bg-blue-600/10 pl-[10px] text-blue-400'
                      : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon
                      className={cn(
                        'h-4 w-4 shrink-0',
                        isActive ? 'text-blue-400' : 'text-zinc-500'
                      )}
                    />
                    <span>{item.label}</span>
                    {item.label === 'Orders' && <PendingOrdersBadge />}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {/* Divider */}
      <div className="border-t border-zinc-800/60" />

      {/* User section */}
      <div className="p-3">
        <div className="flex items-center gap-3 rounded-md px-3 py-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-700 text-xs font-semibold text-zinc-300">
            {me ? (
              me.userId.slice(0, 2).toUpperCase()
            ) : (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-zinc-300">
              {me?.storeName ?? 'Loading...'}
            </p>
            <p className="truncate text-[10px] text-zinc-500 capitalize">
              {me?.environment ?? ''}
            </p>
          </div>
          <button
            onClick={handleLogout}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
            title="Sign out"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  )
}
