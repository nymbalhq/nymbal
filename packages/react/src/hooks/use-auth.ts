import { useSyncExternalStore } from 'react'
import type { Customer } from '@nymbalhq/types'
import type { AuthState, RegisterParams } from '@nymbalhq/sdk'
import { useNymbalClient } from '../context.js'

export interface UseAuthReturn extends AuthState {
  login: (email: string, password: string) => Promise<void>
  /** `verification-sent` on a store that confirms addresses: nobody is signed in until the mailed link is followed. */
  register: (params: RegisterParams) => Promise<'signed-in' | 'verification-sent'>
  verifyEmail: (token: string) => Promise<void>
  resendVerification: (email: string) => Promise<void>
  logout: () => Promise<void>
  refreshToken: () => Promise<void>
  updateProfile: (updates: Partial<Pick<Customer, 'firstName' | 'lastName' | 'phone'>>) => Promise<void>
  loadProfile: () => Promise<void>
}

export function useAuth(): UseAuthReturn {
  const client = useNymbalClient()
  const state = useSyncExternalStore(
    client.auth.subscribe,
    client.auth.getState,
    client.auth.getState,
  )
  return {
    ...state,
    login: client.auth.login,
    register: client.auth.register,
    verifyEmail: client.auth.verifyEmail,
    resendVerification: client.auth.resendVerification,
    logout: client.auth.logout,
    refreshToken: client.auth.refreshToken,
    updateProfile: client.auth.updateProfile,
    loadProfile: client.auth.loadProfile,
  }
}
