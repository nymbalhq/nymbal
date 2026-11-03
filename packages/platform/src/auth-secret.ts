import { isIPv4 } from 'node:net'
import { DEFAULT_JWT_SECRET, type NymbalConfig } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'

export const JWT_SECRET_ENV = 'NYMBAL_JWT_SECRET'
/** The schema's own floor for `security.auth.jwtSecret`. */
const MIN_LENGTH = 16

export interface AuthSecret {
  secret: string
  source: 'config' | 'env' | 'default'
}

/**
 * The secret every token is signed with: the config's own, else NYMBAL_JWT_SECRET, else the schema default. Code that
 * names a secret wins, as it does over the environment for adapter settings. A set variable is checked first, so a
 * malformed one fails the boot even when the config's secret would win.
 */
export function resolveAuthSecret(config: NymbalConfig, env: NodeJS.ProcessEnv): AuthSecret {
  const fromEnv = env[JWT_SECRET_ENV]
  if (fromEnv !== undefined && fromEnv.length < MIN_LENGTH) {
    throw new ConfigError(
      `${JWT_SECRET_ENV} is shorter than ${MIN_LENGTH} characters; set it to a random secret, such as \`openssl rand -base64 32\`.`,
      { code: 'config.jwt_secret_too_short', context: { variable: JWT_SECRET_ENV } },
    )
  }
  const own = config.security.auth.jwtSecret
  if (own !== DEFAULT_JWT_SECRET) return { secret: own, source: 'config' }
  if (fromEnv !== undefined) return { secret: fromEnv, source: 'env' }
  return { secret: DEFAULT_JWT_SECRET, source: 'default' }
}

/**
 * Whether a listen host is reachable from this machine only: 127.0.0.0/8, ::1 or localhost. The wildcards `0.0.0.0`
 * and `::` listen on every interface, so they are not. Any other spelling of a loopback address is treated as
 * reachable, which refuses more, never less.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
  if (h === 'localhost' || h === '::1') return true
  return isIPv4(h) && h.startsWith('127.')
}
