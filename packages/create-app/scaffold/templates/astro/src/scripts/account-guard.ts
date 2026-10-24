import { client } from '../lib/client.js'

export async function guardAuth(): Promise<boolean> {
  let state = client.auth.getState()

  if (!state.isAuthenticated) {
    try {
      await client.auth.loadProfile()
      state = client.auth.getState()
    } catch {
      // will redirect below
    }
  }

  if (!state.isAuthenticated) {
    const redirect = encodeURIComponent(window.location.pathname + window.location.search)
    window.location.href = `/account/login?redirect=${redirect}`
    return false
  }

  return true
}
