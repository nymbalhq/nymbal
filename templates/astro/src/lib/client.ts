import '../elements/index.js'
import { createNymbalClient } from '@nymbalhq/sdk'
import { registerClient } from '@nymbalhq/web-components'

const client = createNymbalClient({
  baseUrl: import.meta.env.PUBLIC_NYMBAL_API_URL ?? 'http://localhost:3001',
  tokenStorage: 'localStorage',
})

registerClient(client)
// A payment driver of the project's own goes here, before any element is defined: registerPaymentDriver(name, driver)
// from @nymbalhq/sdk, named by the driver of the payments adapter's client half.
client.cart.load()

export { client }
