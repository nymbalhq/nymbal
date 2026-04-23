import { describe, it, expect, vi } from 'vitest'
import { createAuthStore } from './auth-store.js'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import type { TokenManager } from '../auth/token-manager.js'
import type { Customer } from '@nymbal/types'

const testCustomer: Customer = {
  id: 'cust-1', email: 'test@example.com',
  firstName: 'Jane', lastName: 'Doe', phone: '',
  addresses: [], orderCount: 0, totalSpentMinor: 0,
  metadata: {}, requiresPasswordReset: false,
  createdAt: '', updatedAt: '',
}

const testAuthResult = { customer: testCustomer, accessToken: 'tok', refreshToken: 'rtok', expiresIn: 900 }

function makeAdapter(): CommerceAdapter {
  return {
    customers: {
      login: vi.fn().mockResolvedValue(testAuthResult),
      register: vi.fn().mockResolvedValue(testAuthResult),
      logout: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn().mockResolvedValue({ accessToken: 'new-tok', expiresIn: 900 }),
      getProfile: vi.fn().mockResolvedValue(testCustomer),
      updateProfile: vi.fn().mockResolvedValue({ ...testCustomer, firstName: 'Updated' }),
    },
  } as unknown as CommerceAdapter
}

function makeTokenManager(): TokenManager {
  return {
    getAccessToken: vi.fn().mockReturnValue('tok'),
    setTokens: vi.fn(),
    clear: vi.fn(),
    scheduleRefresh: vi.fn(),
    destroy: vi.fn(),
  }
}

describe('AuthStore', () => {
  it('initial state is unauthenticated', () => {
    const store = createAuthStore(makeAdapter(), makeTokenManager())
    expect(store.getState().isAuthenticated).toBe(false)
    expect(store.getState().customer).toBeNull()
  })

  it('login sets authenticated state and calls tokenManager.setTokens', async () => {
    const adapter = makeAdapter()
    const tokenManager = makeTokenManager()
    const store = createAuthStore(adapter, tokenManager)
    await store.login('test@example.com', 'pass123')
    expect(store.getState().isAuthenticated).toBe(true)
    expect(store.getState().customer?.email).toBe('test@example.com')
    expect(tokenManager.setTokens).toHaveBeenCalledWith('tok', 900)
  })

  it('login on failure sets error state', async () => {
    const adapter = makeAdapter()
    vi.mocked(adapter.customers.login).mockRejectedValueOnce(new Error('invalid credentials'))
    const store = createAuthStore(adapter, makeTokenManager())
    await store.login('bad@example.com', 'wrong')
    expect(store.getState().isAuthenticated).toBe(false)
    expect(store.getState().error).toBe('invalid credentials')
  })

  it('register sets authenticated state', async () => {
    const store = createAuthStore(makeAdapter(), makeTokenManager())
    await store.register({ email: 'new@example.com', password: 'pass123' })
    expect(store.getState().isAuthenticated).toBe(true)
  })

  it('logout clears state and calls tokenManager.clear', async () => {
    const tokenManager = makeTokenManager()
    const store = createAuthStore(makeAdapter(), tokenManager)
    await store.login('test@example.com', 'pass')
    await store.logout()
    expect(store.getState().isAuthenticated).toBe(false)
    expect(store.getState().customer).toBeNull()
    expect(tokenManager.clear).toHaveBeenCalled()
  })

  it('logout clears token even on adapter error', async () => {
    const adapter = makeAdapter()
    vi.mocked(adapter.customers.logout).mockRejectedValueOnce(new Error('network'))
    const tokenManager = makeTokenManager()
    const store = createAuthStore(adapter, tokenManager)
    await store.login('test@example.com', 'pass')
    await store.logout()
    expect(tokenManager.clear).toHaveBeenCalled()
    expect(store.getState().isAuthenticated).toBe(false)
  })

  it('loadProfile loads customer into state', async () => {
    const store = createAuthStore(makeAdapter(), makeTokenManager())
    await store.loadProfile()
    expect(store.getState().customer?.email).toBe('test@example.com')
    expect(store.getState().isAuthenticated).toBe(true)
  })

  it('updateProfile updates customer in state', async () => {
    const store = createAuthStore(makeAdapter(), makeTokenManager())
    await store.login('test@example.com', 'pass')
    await store.updateProfile({ firstName: 'Updated' })
    expect(store.getState().customer?.firstName).toBe('Updated')
  })

  it('refreshToken calls adapter.customers.refresh and updates token', async () => {
    const adapter = makeAdapter()
    const tokenManager = makeTokenManager()
    const store = createAuthStore(adapter, tokenManager)
    await store.refreshToken()
    expect(tokenManager.setTokens).toHaveBeenCalledWith('new-tok', 900)
  })
})
