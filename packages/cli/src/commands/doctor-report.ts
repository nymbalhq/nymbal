import pc from 'picocolors'
import type { NymbalConfig } from '@nymbalhq/config'
import { scrub as scrubSettings, type DiagnosisReport } from '@nymbalhq/platform'
import { connectionSecrets, displayUrl, SECRET_MIN_LENGTH } from '@nymbalhq/types'

export interface FormatDoctorOptions {
  json: boolean
  /** The config the report was made from: its secret values are removed from every detail. */
  config?: NymbalConfig | undefined
  /** The environment it was made from, `.env` included: likewise. */
  env?: NodeJS.ProcessEnv
}

type Status = DiagnosisReport['checks'][number]['status']

const TEXT_STATUS: Record<Status, 'ok' | 'warn' | 'down'> = {
  ok: 'ok',
  healthy: 'ok',
  degraded: 'warn',
  down: 'down',
}

const JSON_STATUS: Record<Status, 'ok' | 'degraded' | 'down'> = {
  ok: 'ok',
  healthy: 'ok',
  degraded: 'degraded',
  down: 'down',
}

const COLOUR = { ok: pc.green, warn: pc.yellow, down: pc.red }

/** Config keys whose values are secrets: `secretKey`, `webhookSecret`, `jwtSecret`, SMTP's `pass`, an `apiKey`. */
const SECRET_KEY =
  /secret|passw(?:or)?d|^pass$|token|api[-_]?key|private[-_]?key|credential|access[-_]?key/i
/** Environment variables whose values are secrets: `STRIPE_SECRET_KEY`, `SMTP_PASS`, `AWS_SECRET_ACCESS_KEY`. */
const SECRET_ENV =
  /SECRET|PASSWORD|PASSWD|(?:^|_)PASS(?:$|_)|TOKEN|API_KEY|PRIVATE_KEY|CREDENTIAL|ACCESS_KEY/i
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>]+/gi
const TRAILING_PUNCTUATION = /[.,;:)\]}]+$/

function addSecret(into: Set<string>, value: string): void {
  if (value.length >= SECRET_MIN_LENGTH) into.add(value)
}

function collectFromConfig(value: unknown, key: string, into: Set<string>, seen: WeakSet<object>) {
  if (typeof value === 'string') {
    if (SECRET_KEY.test(key)) addSecret(into, value)
    if (value.includes('://'))
      for (const s of connectionSecrets(value, { user: false })) addSecret(into, s)
    return
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  for (const [k, v] of Object.entries(value)) collectFromConfig(v, k, into, seen)
}

/** Every value of `config` and `env` that must not be printed, longest first. */
function secretsOf(config: NymbalConfig | undefined, env: NodeJS.ProcessEnv): string[] {
  const found = new Set<string>()
  collectFromConfig(config, '', found, new WeakSet())
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (SECRET_ENV.test(name)) addSecret(found, value)
    if (value.includes('://'))
      for (const s of connectionSecrets(value, { user: false })) addSecret(found, s)
  }
  return [...found].sort((a, b) => b.length - a.length)
}

/**
 * A detail as it may be printed: on one line, every URL as `scheme://host:port/db`, and no secret value, whether the
 * config and env hold it or diagnose decrypted it from Settings.
 */
function scrub(detail: string, secrets: readonly string[]): string {
  let text = scrubSettings(detail).replace(URL_IN_TEXT, (match) => {
    const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? ''
    return displayUrl(match.slice(0, match.length - trailing.length)) + trailing
  })
  for (const secret of secrets) text = text.split(secret).join('***')
  return text.replace(/\s*\n\s*(?:•\s*)?/g, ' ').trim()
}

/**
 * Doctor's output: one line per check (`<ok|warn|down>  <name>  <detail>`) and a count, or with `json` one document,
 * `{ checks: [{ name, status, detail }] }`, whose status is `ok`, `degraded` or `down`. Neither prints a secret.
 */
export function formatDoctorReport(report: DiagnosisReport, options: FormatDoctorOptions): string {
  const secrets = secretsOf(options.config, options.env ?? {})
  const checks = report.checks.map((check) => ({
    name: check.name,
    status: check.status,
    detail: scrub(check.detail, secrets),
  }))
  if (options.json) {
    return JSON.stringify(
      {
        checks: checks.map((c) => ({
          name: c.name,
          status: JSON_STATUS[c.status],
          detail: c.detail,
        })),
      },
      null,
      2,
    )
  }
  const width = Math.max(...checks.map((c) => c.name.length), 0)
  const lines = checks.map((c) => {
    const status = TEXT_STATUS[c.status]
    return `${COLOUR[status](status.padEnd(4))}  ${c.name.padEnd(width)}  ${c.detail}`.trimEnd()
  })
  const count = (s: 'ok' | 'warn' | 'down') =>
    checks.filter((c) => TEXT_STATUS[c.status] === s).length
  return [...lines, '', `${count('down')} down, ${count('warn')} warn, ${count('ok')} ok`].join(
    '\n',
  )
}
