import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { isAuthenticated, setToken, clearToken } from '@/lib/auth'
import { queryClient } from '@/lib/query-client'
import type { LoginResponse } from '@/types'

export function useAuth() {
  const navigate = useNavigate()

  const login = useCallback(async (email: string, password: string): Promise<void> => {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })

    const data = await response.json() as { data?: LoginResponse['data']; error?: { code: string; message: string } }

    if (!response.ok || !data.data) {
      throw new Error(data.error?.message ?? 'Login failed')
    }

    const { accessToken, customer } = data.data
    const roles = (customer.metadata as { roles?: string[] } | undefined)?.roles ?? []

    if (!roles.includes('admin')) {
      throw new Error('Not authorized: admin role required')
    }

    setToken(accessToken)
    await queryClient.invalidateQueries({ queryKey: ['me'] })
    navigate('/')
  }, [navigate])

  const logout = useCallback(() => {
    clearToken()
    queryClient.clear()
    navigate('/login')
  }, [navigate])

  return {
    isAuthenticated: isAuthenticated(),
    login,
    logout,
  }
}
