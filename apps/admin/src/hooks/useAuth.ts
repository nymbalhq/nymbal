import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { isAuthenticated, setToken, clearToken } from '@/lib/auth'
import { api, fetchWithCsrf } from '@/lib/api'
import { queryClient } from '@/lib/query-client'
import type { LoginResponse } from '@/types'

const TOO_MANY_SIGN_INS =
  'Too many sign-in attempts. Reset the password on your store at /account/forgot-password, or try again later.'

export function useAuth() {
  const navigate = useNavigate()

  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      const response = await fetchWithCsrf('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })

      const data = (await response.json()) as {
        data?: LoginResponse['data']
        error?: { code: string; message: string }
      }

      if (response.status === 429) {
        // Past the store's ceiling every sign-in for the account is refused until its window ends; the admin cannot
        // link to the storefront, whose origin it does not know, so it names the path.
        throw new Error(TOO_MANY_SIGN_INS)
      }
      if (!response.ok || !data.data) {
        throw new Error(data.error?.message ?? 'Login failed')
      }

      const { accessToken, customer } = data.data
      if (!customer.roles.includes('admin')) {
        throw new Error('Not authorized: admin role required')
      }

      setToken(accessToken)
      await queryClient.invalidateQueries({ queryKey: ['me'] })
      navigate('/')
    },
    [navigate],
  )

  const logout = useCallback(async (): Promise<void> => {
    // The server revokes the refresh token and expires its cookie, so a reload cannot restore the session.
    await api.post('/api/auth/logout').catch(() => undefined)
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
