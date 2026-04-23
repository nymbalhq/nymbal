import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { NymbalProvider } from '../context.js'
import { useAuth } from './use-auth.js'
import type { NymbalClient, AuthState } from '@nymbal/sdk'
import type { ReactNode } from 'react'

function makeAuthStore(initial: Partial<AuthState> = {}) {
  let state: AuthState = { customer: null, isAuthenticated: false, loading: false, error: null, ...initial }
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    setState: (p: Partial<AuthState>) => { state = { ...state, ...p }; for (const l of listeners) l() },
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) },
    login: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    refreshToken: vi.fn().mockResolvedValue(undefined),
    updateProfile: vi.fn().mockResolvedValue(undefined),
    loadProfile: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
  }
}

function makeClient(authStore = makeAuthStore()): NymbalClient {
  return { auth: authStore } as unknown as NymbalClient
}

function makeWrapper(client: NymbalClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <NymbalProvider client={client}>{children}</NymbalProvider>
  }
}

describe('useAuth', () => {
  it('initial state is unauthenticated', () => {
    const { result } = renderHook(() => useAuth(), { wrapper: makeWrapper(makeClient()) })
    expect(result.current.isAuthenticated).toBe(false)
    expect(result.current.customer).toBeNull()
  })

  it('re-renders on auth state change', () => {
    const authStore = makeAuthStore()
    const { result } = renderHook(() => useAuth(), { wrapper: makeWrapper(makeClient(authStore)) })
    act(() => {
      authStore.setState({ isAuthenticated: true, customer: { id: 'c1' } as never })
    })
    expect(result.current.isAuthenticated).toBe(true)
  })

  it('exposes login function', async () => {
    const authStore = makeAuthStore()
    const { result } = renderHook(() => useAuth(), { wrapper: makeWrapper(makeClient(authStore)) })
    await act(async () => {
      await result.current.login('user@test.com', 'pass')
    })
    expect(authStore.login).toHaveBeenCalledWith('user@test.com', 'pass')
  })

  it('cleanup on unmount', () => {
    const authStore = makeAuthStore()
    const { unmount } = renderHook(() => useAuth(), { wrapper: makeWrapper(makeClient(authStore)) })
    unmount()
    expect(true).toBe(true) // no error
  })
})
