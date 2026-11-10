import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithProviders } from '@/tests/render'
import { clearToken } from '@/lib/auth'
import { LoginPage } from './LoginPage'

// An account whose failed sign-ins reached the store's ceiling is refused 429 from anywhere until its window ends, the
// right password included. The way out is a reset on the storefront, which the admin cannot link to (it does not know
// the storefront's origin), so its sign-in says where to go: the storefront path `/account/forgot-password`. Any other
// refusal shows the API's own message, as before.

const FORGOT_PATH = '/account/forgot-password'

/** A fake API whose `POST /api/auth/login` answers `status` with `error`; the CSRF read answers a token. */
function apiRefusingLogin(status: number, error: { code: string; message: string }) {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    if (url.pathname === '/api/csrf') {
      return new Response(JSON.stringify({ data: { token: 'csrf-token' } }), { status: 200 })
    }
    if (url.pathname === '/api/auth/login') {
      return new Response(JSON.stringify({ error }), {
        status,
        headers: status === 429 ? { 'retry-after': '900' } : {},
      })
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 })
  })
}

/** Signs in through the page as the admin does against an API refusing with `status`; what the error element says. */
async function errorShown(
  status: number,
  error: { code: string; message: string },
): Promise<string> {
  apiRefusingLogin(status, error)
  const user = userEvent.setup()
  const { unmount } = renderWithProviders(<LoginPage />, { initialPath: '/login' })
  try {
    await user.type(screen.getByTestId('admin-login-email'), 'admin@shop.test')
    await user.type(screen.getByTestId('admin-login-password'), 'a-password')
    await user.click(screen.getByTestId('admin-login-submit'))
    return (await screen.findByTestId('admin-login-error')).textContent ?? ''
  } finally {
    unmount()
    vi.unstubAllGlobals()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  clearToken()
})

describe('AC-28: the admin sign-in names the storefront’s reset page when the account is capped', () => {
  // Defect: the admin is told only "Too many requests", so the way out the ceiling depends on is not visible where
  // lockout costs most; or every refusal is rewritten to that text, hiding a wrong password behind a lockout message.
  it('AC-28: a 429 from /api/auth/login shows admin-login-error naming /account/forgot-password, and a 401 still shows the API’s own message, which names no reset page', async () => {
    const capped = { code: 'rate_limit.block', message: 'Too many requests' }
    const wrong = { code: 'auth.invalid_credentials', message: 'Invalid email or password' }
    const refusals = [
      { status: 429, error: capped },
      { status: 401, error: wrong },
    ]

    const shown: string[] = []
    for (const r of refusals) shown.push(await errorShown(r.status, r.error))

    expect(shown.map((text) => text.includes(FORGOT_PATH))).toEqual(
      refusals.map((r) => r.status === 429),
    )
    expect(shown[0]).not.toBe(capped.message)
    expect(shown[1]).toBe(wrong.message)
  })
})
