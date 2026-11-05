import { ConfigError, type ResolvedOriginLock } from '@nymbalhq/types'
import type { NymbalConfig } from './schema.js'

export const ORIGIN_SECRET_ENV = 'NYMBAL_ORIGIN_SECRET'

/** Long enough not to be guessed, and only characters any CDN can send in a header value. */
const ENTRY = /^[A-Za-z0-9+/=_.~-]{32,256}$/

/**
 * The origin lock from `NYMBAL_ORIGIN_SECRET`: one secret, or several separated by commas while one is rotated out.
 * Blank entries are dropped and a blank variable is unset. A refusal names the entry's position, never its text, since
 * the message reaches logs and terminals.
 */
export function resolveOriginLock(
  config: NymbalConfig,
  env: NodeJS.ProcessEnv,
): ResolvedOriginLock | undefined {
  const secrets = (env[ORIGIN_SECRET_ENV] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  if (secrets.length === 0) return undefined
  const invalid = secrets.findIndex((entry) => !ENTRY.test(entry))
  if (invalid >= 0) {
    const position = invalid + 1
    throw new ConfigError(
      `${ORIGIN_SECRET_ENV} entry ${position} is not an origin secret: each entry is 32 to 256 characters of A-Z a-z 0-9 + / = _ . ~ - (nymbal security:apply makes one)`,
      { code: 'config.origin_secret_invalid', context: { variable: ORIGIN_SECRET_ENV, position } },
    )
  }
  return { header: config.security.originLock.header, secrets }
}
