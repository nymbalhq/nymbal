'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuth } from '@nymbalhq/react'
import { restoreSession } from '@/lib/client'

export const PUBLIC_AUTH_PATHS = ['/account/login', '/account/register']

export function AuthGuard({ children }: { children: ReactNode }) {
  const { isAuthenticated, loading } = useAuth()
  const router = useRouter()
  const pathname = usePathname()
  // A stored token is only known to be valid once its profile has loaded; redirecting before that would sign a
  // reloading shopper out.
  const [restored, setRestored] = useState(false)

  const isPublicAuthPath = PUBLIC_AUTH_PATHS.includes(pathname)

  useEffect(() => {
    let active = true
    void restoreSession().finally(() => {
      if (active) setRestored(true)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (restored && !loading && !isAuthenticated && !isPublicAuthPath) {
      router.replace(`/account/login?redirect=${encodeURIComponent(pathname)}`)
    }
  }, [restored, loading, isAuthenticated, isPublicAuthPath, pathname, router])

  if (isPublicAuthPath) {
    return <>{children}</>
  }

  if (!restored || loading) {
    return (
      <div className="loading-center">
        <div className="spinner spinner-lg" role="status">
          <span className="visually-hidden">Loading...</span>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return null
  }

  return <>{children}</>
}
