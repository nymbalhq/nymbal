import { type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useAuth } from './useAuth'
import { clearToken, getToken } from '@/lib/auth'

// AC-9: the admin login sends `x-csrf-token` from `GET /api/csrf`, and reads the admin role from `customer.roles`,
// not `metadata`.

interface Call {
  method: string
  path: string
  csrf: string | null
}

function fakeApi(customer: { roles: string[]; metadata: Record<string, unknown> }) {
  const calls: Call[] = []
  const issued: string[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ method, path: url.pathname, csrf: new Headers(init.headers).get('x-csrf-token') })
    if (url.pathname === '/api/csrf') {
      const token = `login-tok-${issued.length + 1}`
      issued.push(token)
      return new Response(JSON.stringify({ data: { token } }), { status: 200 })
    }
    if (url.pathname === '/api/auth/login') {
      const body = {
        data: {
          accessToken: 'access-1',
          expiresIn: 900,
          customer: { id: 'c1', email: 'a@b.c', ...customer },
        },
      }
      return new Response(JSON.stringify(body), { status: 200 })
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 })
  })
  return { calls, issued }
}

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/login']}>{children}</MemoryRouter>
}

afterEach(() => {
  vi.unstubAllGlobals()
  clearToken()
})

describe('admin login CSRF and roles', () => {
  it('AC-9: login POSTs /api/auth/login with x-csrf-token equal to the token from GET /api/csrf, and an admin in customer.roles is signed in', async () => {
    const fake = fakeApi({ roles: ['admin'], metadata: {} })
    const { result } = renderHook(() => useAuth(), { wrapper })

    await act(async () => {
      await result.current.login('admin@nymbal.local', 'pw')
    })

    const logins = fake.calls.filter((c) => c.path === '/api/auth/login')
    expect(logins).toHaveLength(1)
    expect(logins[0]!.csrf).not.toBeNull()
    expect(logins[0]!.csrf).toBe(fake.issued.at(-1))
    expect(getToken()).toBe('access-1')
  })
})
