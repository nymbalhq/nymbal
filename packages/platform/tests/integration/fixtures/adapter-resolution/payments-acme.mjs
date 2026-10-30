// A third party's payments adapter, as `package:` names it (the tests alias the specifier to this file). It serves
// payments under the provider name 'acme', lets Settings fill `provider` and `package` in its block, and records the
// slot and config the kernel built it with.
import { createNativeStubPaymentsAdapter } from '../../../../dist/index.js'

export const slot = 'payments'
export const provider = 'acme'
export const settings = [
  { path: 'provider', label: 'Provider', secret: false },
  { path: 'package', label: 'Package', secret: false },
]

export function createAdapter(ctx) {
  globalThis.__nymbalFixtureReceived ??= {}
  globalThis.__nymbalFixtureReceived.payments = { slot: ctx.slot, config: ctx.config }
  return {
    ...createNativeStubPaymentsAdapter({ logger: ctx.logger }),
    providerName: 'acme-payments',
  }
}
