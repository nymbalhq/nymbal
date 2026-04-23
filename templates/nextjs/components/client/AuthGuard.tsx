'use client'

import { useEffect, type ReactNode } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuth } from '@nymbal/react'

const PUBLIC_AUTH_PATHS = ['/account/login', '/account/register']

export function AuthGuard({ children }: { children: ReactNode }) {
  const { isAuthenticated, loading } = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  const isPublicAuthPath = PUBLIC_AUTH_PATHS.includes(pathname)

  useEffect(() => {
    if (!loading && !isAuthenticated && !isPublicAuthPath) {
      router.replace(`/account/login?redirect=${encodeURIComponent(pathname)}`)
    }
  }, [loading, isAuthenticated, isPublicAuthPath, pathname, router])

  if (isPublicAuthPath) {
    return <>{children}</>
  }

  if (loading) {
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
