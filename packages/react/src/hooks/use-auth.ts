import { useSyncExternalStore } from 'react'
import type { Customer } from '@nymbal/types'
import type { AuthState, RegisterParams } from '@nymbal/sdk'
import { useNymbalClient } from '../context.js'

export interface UseAuthReturn extends AuthState {
  login: (email: string, password: string) => Promise<void>
  register: (params: RegisterParams) => Promise<void>
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
    logout: client.auth.logout,
    refreshToken: client.auth.refreshToken,
    updateProfile: client.auth.updateProfile,
    loadProfile: client.auth.loadProfile,
  }
}
