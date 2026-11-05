// A third party's security adapter that offers the HTTP layer its network settings, as a CDN's adapter would. Its
// `security.config` says what to do: `network` is what network() returns, `mode` 'fail-build' makes createAdapter
// throw and 'network-throws' makes network() throw. Otherwise it acts as the kernel's middleware adapter.
import { createMiddlewareSecurityAdapter } from '../../../../platform/dist/index.js'

export const slot = 'security'
export const provider = 'edge'

export function createAdapter(ctx) {
  const { mode, network = {} } = ctx.config
  if (mode === 'fail-build') throw new Error('the edge adapter could not reach its edge')
  return {
    ...createMiddlewareSecurityAdapter({ logger: ctx.logger }),
    providerName: 'edge',
    network() {
      if (mode === 'network-throws') throw new Error('the edge adapter has no network settings')
      return network
    },
  }
}
