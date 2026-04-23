import { createContext, useContext, type ReactNode } from 'react'
import type { NymbalClient } from '@nymbal/sdk'

const NymbalContext = createContext<NymbalClient | null>(null)

export interface NymbalProviderProps {
  client: NymbalClient
  children: ReactNode
}

export function NymbalProvider({ client, children }: NymbalProviderProps): ReactNode {
  return <NymbalContext.Provider value={client}>{children}</NymbalContext.Provider>
}

export function useNymbalClient(): NymbalClient {
  const client = useContext(NymbalContext)
  if (!client) {
    throw new Error('useNymbalClient must be used within <NymbalProvider>')
  }
  return client
}
