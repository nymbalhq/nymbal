import { Outlet } from 'react-router-dom'
import { Sidebar } from '@/components/layout/Sidebar'
import { TopBar } from '@/components/layout/TopBar'
import { RealtimeProvider } from '@/realtime/provider'

export function AdminLayout() {
  return (
    <RealtimeProvider>
      <div className="min-h-screen bg-zinc-100">
        <Sidebar />
        <TopBar />
        <main className="ml-60 pt-14 min-h-screen">
          <div className="p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </RealtimeProvider>
  )
}
