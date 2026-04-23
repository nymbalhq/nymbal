import { createNymbalClient, type NymbalClient } from '@nymbal/sdk'

let instance: NymbalClient | null = null

export function getNymbalClient(): NymbalClient {
  if (!instance) {
    instance = createNymbalClient({
      baseUrl: process.env.NEXT_PUBLIC_NYMBAL_API_URL ?? 'http://localhost:3001',
      tokenStorage: 'localStorage',
    })
  }
  return instance
}
