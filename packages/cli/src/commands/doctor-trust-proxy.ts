import type { NymbalConfig } from '@nymbalhq/config'
import { resolveTrustProxy } from '@nymbalhq/http'
import type { DiagnosisCheck } from '@nymbalhq/platform'
import { ConfigError } from '@nymbalhq/types'

const VARIABLE = 'NYMBAL_TRUST_PROXY_HOPS'
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

/**
 * The proxy hop count the server would resolve, read before the first shopper: with none set and a public origin,
 * every shopper behind a reverse proxy would share the proxy's rate-limit buckets.
 */
export function trustProxyCheck(config: NymbalConfig, env: NodeJS.ProcessEnv): DiagnosisCheck {
  let resolved: boolean | number
  try {
    resolved = resolveTrustProxy(config, env)
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    return { name: NAME, status: 'down', detail: error.message }
  }
  if (resolved === true) {
    return {
      name: NAME,
      status: 'degraded',
      detail:
        'every X-Forwarded-For hop is trusted: a client can choose its own address; set a hop count',
    }
  }
  if (resolved === false) {
    return isPublicOrigin(env['NYMBAL_PUBLIC_URL'])
      ? {
          name: NAME,
          status: 'degraded',
          detail: `0 hops and a public origin: behind a reverse proxy every shopper shares one rate-limit bucket; set ${VARIABLE}`,
        }
      : { name: NAME, status: 'ok', detail: '0 hops, the default: no proxy in front' }
  }
  const source = config.http.trustProxy === false ? VARIABLE : 'http.trustProxy'
  return {
    name: NAME,
    status: 'ok',
    detail: `${resolved} ${resolved === 1 ? 'hop' : 'hops'}, from ${source}`,
  }
}
