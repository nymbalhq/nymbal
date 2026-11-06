import { TRUSTED_PROXIES_ENV, resolveTrustedProxies, type NymbalConfig } from '@nymbalhq/config'
import type { DiagnosisCheck, DiagnosisReport } from '@nymbalhq/platform'
import { ConfigError, type NetworkSource, type ResolvedNetwork } from '@nymbalhq/types'

const NAME = 'trust proxy'

/** Whether `value` is an http(s) origin on a host other than this machine: one a reverse proxy may sit in front of. */
function isPublicOrigin(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return false
  try {
    const { protocol, hostname } = new URL(value.trim())
    if (protocol !== 'http:' && protocol !== 'https:') return false
    return !(
      hostname === 'localhost' ||
      hostname === '[::1]' ||
      /^127(\.\d{1,3}){3}$/.test(hostname)
    )
  } catch {
    return false
  }
}

function from(source: NetworkSource): string {
  if (source.kind === 'default') return 'the default'
  return source.kind === 'adapter' ? `from adapter ${source.name}` : `from ${source.name}`
}

function describe(network: ResolvedNetwork): string {
  const list = network.trustedProxies.length === 0 ? 'none' : network.trustedProxies.join(', ')
  const joiner = network.trustedProxiesSource.kind === 'default' ? ', ' : ' '
  const listed = `trusted proxies: ${list}${joiner}${from(network.trustedProxiesSource)}`
  if (network.clientIpHeader === undefined || network.clientIpHeaderSource === undefined) {
    return listed
  }
  return `${listed}; client address header: ${network.clientIpHeader} ${from(network.clientIpHeaderSource)}`
}

/**
 * The trusted proxy list and client-address header the server would resolve, each with where it came from, read before
 * the first shopper. The default list with a public origin is degraded: behind a platform proxy every shopper would
 * share the proxy's rate-limit buckets. A security adapter's offer that could not be read is never taken as empty.
 */
export function trustProxyCheck(
  config: NymbalConfig,
  env: NodeJS.ProcessEnv,
  offer: DiagnosisReport['network'] = 'unknown',
): DiagnosisCheck {
  let network: ResolvedNetwork
  try {
    network = resolveTrustedProxies(
      config,
      env,
      offer === 'unknown' ? undefined : { adapter: offer.adapter, network: offer.contribution },
    )
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    return { name: NAME, status: 'down', detail: error.message }
  }
  if (offer === 'unknown') {
    return {
      name: NAME,
      status: 'degraded',
      detail: `the security adapter's contribution is unknown (it did not build, or its network() threw); without it, ${describe(network)}`,
    }
  }
  if (network.trustedProxiesSource.kind === 'default' && isPublicOrigin(env['NYMBAL_PUBLIC_URL'])) {
    return {
      name: NAME,
      status: 'degraded',
      detail: `${describe(network)}, and the public origin is not this machine: behind a platform proxy every shopper shares one rate-limit bucket; set ${TRUSTED_PROXIES_ENV} to the proxy's range (uniquelocal on Fly and Railway), or to loopback for a web server on this machine`,
    }
  }
  return { name: NAME, status: 'ok', detail: describe(network) }
}
