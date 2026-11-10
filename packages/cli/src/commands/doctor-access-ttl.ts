import { durationMs, secureCookies, type NymbalConfig } from '@nymbalhq/config'
import type { DiagnosisCheck } from '@nymbalhq/platform'

const NAME = 'access token lifetime'
const DEFAULT_ACCESS_TTL_MS = 15 * 60_000

/**
 * An access token outlives a sign-out and a changed password until it expires, so a real deployment (its cookies are
 * Secure: an https public origin) is warned when one lives longer than the default 15 minutes. A developer's store on
 * http is not.
 */
export function accessTtlCheck(
  config: NymbalConfig,
  env: Record<string, string | undefined>,
): DiagnosisCheck {
  const { accessTtl } = config.security.auth
  if (!secureCookies(config, env)) {
    return { name: NAME, status: 'ok', detail: `${accessTtl}; not an https store, so not checked` }
  }
  // The schema has parsed the config, so the duration is one.
  if ((durationMs(accessTtl) ?? 0) > DEFAULT_ACCESS_TTL_MS) {
    return {
      name: NAME,
      status: 'degraded',
      detail: `${accessTtl}: a signed-out session or a changed password leaves its access token working that long; set security.auth.accessTtl to 15m or less`,
    }
  }
  return { name: NAME, status: 'ok', detail: accessTtl }
}
