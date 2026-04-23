import { createNymbalClient } from '@nymbal/sdk'
import { registerClient, registerComponents } from '@nymbal/web-components'

const client = createNymbalClient({
  baseUrl: import.meta.env.PUBLIC_NYMBAL_API_URL ?? 'http://localhost:3001',
  tokenStorage: 'localStorage',
})

registerClient(client)
registerComponents()
client.cart.load()

export { client }
