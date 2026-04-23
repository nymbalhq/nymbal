import type { Customer } from '@nymbal/types'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import type { TokenManager } from '../auth/token-manager.js'
import type { AuthState, RegisterParams } from '../types.js'
import { createStore } from './create-store.js'

const INITIAL_STATE: AuthState = {
  customer: null,
  isAuthenticated: false,
  loading: false,
  error: null,
}

export interface AuthStore {
  getState(): AuthState
  subscribe(listener: () => void): () => void
  login(email: string, password: string): Promise<void>
  register(params: RegisterParams): Promise<void>
  logout(): Promise<void>
  refreshToken(): Promise<void>
  updateProfile(updates: Partial<Pick<Customer, 'firstName' | 'lastName' | 'phone'>>): Promise<void>
  loadProfile(): Promise<void>
  destroy(): void
}

export function createAuthStore(
  adapter: CommerceAdapter,
  tokenManager: TokenManager,
): AuthStore {
  const store = createStore<AuthState>(INITIAL_STATE)

  async function login(email: string, password: string): Promise<void> {
    store.setState({ loading: true, error: null })
    try {
      const result = await adapter.customers.login(email, password)
      tokenManager.setTokens(result.accessToken, result.expiresIn)
      store.setState({
        customer: result.customer,
        isAuthenticated: true,
        loading: false,
      })
    } catch (err) {
      store.setState({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function register(params: RegisterParams): Promise<void> {
    store.setState({ loading: true, error: null })
    try {
      const result = await adapter.customers.register(params)
      tokenManager.setTokens(result.accessToken, result.expiresIn)
      store.setState({
        customer: result.customer,
        isAuthenticated: true,
        loading: false,
      })
    } catch (err) {
      store.setState({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function logout(): Promise<void> {
    store.setState({ loading: true, error: null })
    try {
      await adapter.customers.logout()
      tokenManager.clear()
      store.setState({
        customer: null,
        isAuthenticated: false,
        loading: false,
      })
    } catch (err) {
      tokenManager.clear()
      store.setState({
        customer: null,
        isAuthenticated: false,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function refreshToken(): Promise<void> {
    try {
      const result = await adapter.customers.refresh()
      tokenManager.setTokens(result.accessToken, result.expiresIn)
    } catch {
      tokenManager.clear()
      store.setState({
        customer: null,
        isAuthenticated: false,
      })
    }
  }

  async function updateProfile(
    updates: Partial<Pick<Customer, 'firstName' | 'lastName' | 'phone'>>,
  ): Promise<void> {
    store.setState({ loading: true, error: null })
    try {
      const customer = await adapter.customers.updateProfile(updates)
      store.setState({ customer, loading: false })
    } catch (err) {
      store.setState({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function loadProfile(): Promise<void> {
    if (!tokenManager.getAccessToken()) return
    store.setState({ loading: true, error: null })
    try {
      const customer = await adapter.customers.getProfile()
      store.setState({
        customer,
        isAuthenticated: true,
        loading: false,
      })
    } catch (err) {
      store.setState({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    login,
    register,
    logout,
    refreshToken,
    updateProfile,
    loadProfile,
    destroy: store.destroy,
  }
}
