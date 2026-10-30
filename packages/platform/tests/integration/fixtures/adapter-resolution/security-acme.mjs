// A third party's security adapter, as `security.package` names it (the tests alias the specifier to this file). It
// records the slot and config the kernel built it with, and otherwise acts as the kernel's middleware adapter.
import { createMiddlewareSecurityAdapter } from '../../../../dist/index.js'

export const slot = 'security'
export const provider = 'acme'

export function createAdapter(ctx) {
  globalThis.__nymbalFixtureReceived ??= {}
  globalThis.__nymbalFixtureReceived.security = { slot: ctx.slot, config: ctx.config }
  return {
    ...createMiddlewareSecurityAdapter({ logger: ctx.logger }),
    providerName: 'acme-security',
  }
}
