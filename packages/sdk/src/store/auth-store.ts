import type { Customer } from '@nymbalhq/types'
import type { CommerceAdapter } from '../adapter/commerce-adapter.js'
import { forgetSession, hasSessionHint, isSessionRefusal, renewSession } from '../auth/session.js'
import type { TokenManager } from '../auth/token-manager.js'
import type { AuthResult, AuthState, RegisterParams } from '../types.js'
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
  /** Asks for a reset link; the store answers alike whether or not the address has an account. */
  requestPasswordReset(email: string): Promise<void>
  /** Sets a password with a reset link's token and signs in, as `login` does. */
  resetPassword(token: string, password: string): Promise<void>
  /** Changes the password; the store ends every other session and this one holds the new token, as after `login`. */
  changePassword(currentPassword: string, newPassword: string): Promise<void>
  logout(): Promise<void>
  refreshToken(): Promise<void>
  updateProfile(updates: Partial<Pick<Customer, 'firstName' | 'lastName' | 'phone'>>): Promise<void>
  loadProfile(): Promise<void>
  /**
   * Brings a page load's session back: the profile with a token held; with none, one refresh from the refresh cookie
   * when this browser has signed in (the session hint), then the profile; a guest's sends nothing. Never throws.
   */
  restore(): Promise<void>
  destroy(): void
}

export function createAuthStore(
  adapter: CommerceAdapter,
  tokenManager: TokenManager,
  restoreSession: () => Promise<void> = () => renewSession(adapter, tokenManager),
): AuthStore {
  const store = createStore<AuthState>(INITIAL_STATE)

  /**
   * Holds the session a sign-in answered: its token and its customer. Rethrows a refusal, with its message kept. A
   * `busy` sign-in marks the store loading meanwhile; a change of password does not, since a page that hides behind
   * `loading` (an account guard) would take down the signed-in shopper's form mid-change.
   */
  async function signIn(answer: () => Promise<AuthResult>, busy = true): Promise<void> {
    if (busy) store.setState({ loading: true, error: null })
    try {
      const result = await answer()
      tokenManager.setTokens(result.accessToken, result.expiresIn)
      store.setState({
        customer: result.customer,
        isAuthenticated: true,
        loading: false,
        error: null,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      store.setState({ ...(busy && { loading: false }), error: message })
      throw err
    }
  }

  function login(email: string, password: string): Promise<void> {
    return signIn(() => adapter.customers.login(email, password))
  }

  function register(params: RegisterParams): Promise<void> {
    return signIn(() => adapter.customers.register(params))
  }

  async function logout(): Promise<void> {
    store.setState({ loading: true, error: null })
    try {
      await adapter.customers.logout()
      tokenManager.clear()
      forgetSession()
      store.setState({
        customer: null,
        isAuthenticated: false,
        loading: false,
      })
    } catch (err) {
      tokenManager.clear()
      forgetSession()
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
    } catch (err) {
      console.error('[AuthStore] token refresh failed, logging out', err)
      tokenManager.clear()
      if (isSessionRefusal(err)) forgetSession()
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

  async function restore(): Promise<void> {
    if (tokenManager.getAccessToken()) return loadProfile()
    if (!hasSessionHint()) return
    await restoreSession()
    if (tokenManager.getAccessToken()) return loadProfile()
    store.setState({ customer: null, isAuthenticated: false })
  }

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    login,
    register,
    requestPasswordReset: (email) => adapter.customers.requestPasswordReset(email),
    resetPassword: (token, password) =>
      signIn(() => adapter.customers.resetPassword(token, password)),
    changePassword: (currentPassword, newPassword) =>
      signIn(() => adapter.customers.changePassword(currentPassword, newPassword), false),
    logout,
    refreshToken,
    updateProfile,
    loadProfile,
    restore,
    destroy: store.destroy,
  }
}
