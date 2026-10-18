import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'

// P1-06 AC-9: the admin's `request()` sends `x-csrf-token`, taken from `GET /api/csrf`, on unsafe methods and on no
// GET. Kills: the admin left without the header, so every admin write would answer 403.

interface Call {
  method: string
  path: string
  csrf: string | null
}

function fakeApi() {
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
      const token = `admin-tok-${issued.length + 1}`
      issued.push(token)
      return new Response(JSON.stringify({ data: { token } }), { status: 200 })
    }
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })
  })
  return { calls, issued }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('admin request() CSRF', () => {
  it('AC-9: POST, PATCH and DELETE carry x-csrf-token equal to the token from GET /api/csrf; GET carries none', async () => {
    const fake = fakeApi()

    await api.get('/api/admin/orders')
    await api.post('/api/admin/orders/o1/confirm')
    await api.patch('/api/admin/products/p1', { name: 'n' })
    await api.delete('/api/admin/products/p1')

    expect(fake.issued.length).toBeGreaterThan(0)
    const others = fake.calls.filter((c) => c.path !== '/api/csrf')
    const unsafe = others.filter((c) => c.method !== 'GET')
    expect(unsafe).toHaveLength(3)
    for (const call of unsafe) {
      expect(call.csrf, `${call.method} ${call.path}`).not.toBeNull()
      expect(fake.issued, `${call.method} ${call.path}`).toContain(call.csrf)
    }
    for (const call of others.filter((c) => c.method === 'GET')) {
      expect(call.csrf, `${call.method} ${call.path}`).toBeNull()
    }
  })
})
