import { ORIGIN_SECRET_ENV, resolveOriginLock, type NymbalConfig } from '@nymbalhq/config'
import type { DiagnosisCheck, DiagnosisReport } from '@nymbalhq/platform'
import { ConfigError, type ResolvedOriginLock } from '@nymbalhq/types'

const NAME = 'origin lock'

const LOCKOUT_WAYS_OUT = `run nymbal security:apply to put the rule on the zone, or unset ${ORIGIN_SECRET_ENV} and restart to lift the lock`

/** Whether the security adapter asked for the lock: it offered a client-address header that counts only behind it. */
function adapterAskedForLock(report: DiagnosisReport): boolean {
  const network = report.network
  return (
    network !== undefined &&
    network !== 'unknown' &&
    network.contribution.clientIpRequiresLock === true
  )
}

function onLine(lock: ResolvedOriginLock, answer: DiagnosisReport['originLock']): DiagnosisCheck {
  const on = `on: requests from other machines must carry an entry of ${ORIGIN_SECRET_ENV} in ${lock.header}`
  if (answer === 'unmanaged') {
    return {
      name: NAME,
      status: 'ok',
      detail: `${on}; the CDN in front must send it (/health, /ready and this machine are exempt)`,
    }
  }
  if (answer === undefined || answer === 'unknown') {
    return {
      name: NAME,
      status: 'degraded',
      detail: `${on}; could not read whether the zone sends it (see slot security)`,
    }
  }
  if (answer.state === 'missing') {
    return {
      name: NAME,
      status: 'down',
      detail: `${on}, but the zone has no enabled nymbal:origin-lock rule, so every request through it is refused 403: ${LOCKOUT_WAYS_OUT}`,
    }
  }
  if (answer.header.toLowerCase() !== lock.header.toLowerCase()) {
    return {
      name: NAME,
      status: 'down',
      detail: `${on}, but the zone sends its secret in ${answer.header}, so every request through it is refused 403: ${LOCKOUT_WAYS_OUT}`,
    }
  }
  if (answer.entry === null) {
    return {
      name: NAME,
      status: 'down',
      detail: `${on}, but the zone sends a value that is no entry of it, so every request through it is refused 403: ${LOCKOUT_WAYS_OUT}`,
    }
  }
  return {
    name: NAME,
    status: 'ok',
    detail: `${on}; the zone sends entry ${answer.entry + 1} of ${lock.secrets.length}`,
  }
}

/**
 * Whether the API refuses requests that did not cross the CDN, and whether the CDN proves itself: a set secret the zone
 * does not send is the lockout, every request refused. A Cloudflare store without the secret answers requests that skip
 * the edge. No detail holds a secret.
 */
export function originLockCheck(
  config: NymbalConfig,
  env: NodeJS.ProcessEnv,
  report: DiagnosisReport,
): DiagnosisCheck {
  let lock: ResolvedOriginLock | undefined
  try {
    lock = resolveOriginLock(config, env)
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    return { name: NAME, status: 'down', detail: error.message }
  }
  if (lock !== undefined) return onLine(lock, report.originLock)
  if (adapterAskedForLock(report)) {
    return {
      name: NAME,
      status: 'degraded',
      detail:
        `off: ${ORIGIN_SECRET_ENV} is not set, so the API answers requests that skip the CDN and reads no shopper address from it. ` +
        `On Fly or Railway run nymbal security:apply, which creates it and the zone's rule, then set it on the host. ` +
        `Behind nginx, Apache or Caddy on your own server (nymbal deploy nginx) the web server's admission list is the lock; setting ${ORIGIN_SECRET_ENV} there too makes this line ok`,
    }
  }
  return {
    name: NAME,
    status: 'ok',
    detail: `off: ${ORIGIN_SECRET_ENV} is not set, so requests need not cross a CDN`,
  }
}
