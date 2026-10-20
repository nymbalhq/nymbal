import { useState } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { RealtimeProvider } from '@/realtime/provider'

export function AdminLayout() {
  // Below md the sidebar is off-canvas; at md and up it is always shown and this state has no effect.
  const [navOpen, setNavOpen] = useState(false)

  return (
    <RealtimeProvider>
      <div className="min-h-screen bg-zinc-100">
        {navOpen && (
          <div
            aria-hidden="true"
            className="fixed inset-0 z-40 bg-zinc-950/50 md:hidden"
            onClick={() => setNavOpen(false)}
          />
        )}
        <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
        <TopBar navOpen={navOpen} onToggleNav={() => setNavOpen((open) => !open)} />
        <main className="md:ml-60 pt-14 min-h-screen">
          <div className="p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </RealtimeProvider>
  )
}
