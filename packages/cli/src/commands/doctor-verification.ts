import { promises as dns } from 'node:dns'
import { secureCookies, type NymbalConfig } from '@nymbalhq/config'
import { resolveVerification, type DiagnosisCheck } from '@nymbalhq/platform'

const VERIFICATION = 'email verification'
const MAIL_DOMAIN = 'mail domain'
const ADD_PROVIDER = 'add an email provider (`nymbal add email-resend`)'

export type ResolveTxt = (name: string) => Promise<string[][]>

const delivers = (config: NymbalConfig): boolean => config.commerce.email.provider !== 'native'

/**
 * What a real deployment's sign-up policy gives up (its cookies are Secure: an https public origin). `off` lets
 * registering show which addresses have accounts; `required` with mail that only reaches the log, or with no store URL
 * to link to, leaves nobody able to confirm. A developer's store on http is not checked.
 */
export function verificationCheck(
  config: NymbalConfig,
  env: Record<string, string | undefined>,
): DiagnosisCheck {
  const policy = resolveVerification(config.security.auth.verification, delivers(config))
  if (!secureCookies(config, env)) {
    return {
      name: VERIFICATION,
      status: 'ok',
      detail: `${policy}; not an https store, so not checked`,
    }
  }
  if (policy === 'off') {
    const fix = delivers(config)
      ? 'set security.auth.verification to required'
      : `${ADD_PROVIDER}, which makes it required`
    return {
      name: VERIFICATION,
      status: 'degraded',
      detail: `off: sign-ups are not confirmed by email, so registering shows whether an address has an account; ${fix}`,
    }
  }
  if (!delivers(config)) {
    return {
      name: VERIFICATION,
      status: 'degraded',
      detail: `required, but the native email provider only logs, so nobody can confirm a sign-up; ${ADD_PROVIDER}`,
    }
  }
  if (config.store.url === undefined) {
    return {
      name: VERIFICATION,
      status: 'degraded',
      detail:
        'required, but store.url is not set, so no confirmation link can be mailed; set store.url',
    }
  }
  return { name: VERIFICATION, status: 'ok', detail: policy }
}

/** The domain of the configured `from` address (`Acme <orders@acme.com>` reads `acme.com`), else the store's host. */
function mailDomainOf(config: NymbalConfig): string | null {
  const from = (config.commerce.email.config as { from?: unknown } | undefined)?.from
  if (typeof from === 'string') {
    const address = /<([^>]*)>/.exec(from)?.[1] ?? from
    const at = address.lastIndexOf('@')
    if (at !== -1)
      return address
        .slice(at + 1)
        .trim()
        .toLowerCase()
  }
  // `store.url` is a URL by the config schema.
  return config.store.url === undefined ? null : new URL(config.store.url).hostname
}

type Lookup = { found: boolean } | { unreadable: string }

/** Whether a TXT record at `name` starts with `prefix`. No record, or no name, is a missing record, not a failure. */
async function lookup(resolveTxt: ResolveTxt, name: string, prefix: RegExp): Promise<Lookup> {
  try {
    const records = await resolveTxt(name)
    return { found: records.some((chunks) => prefix.test(chunks.join(''))) }
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 'ENODATA' || code === 'ENOTFOUND') return { found: false }
    return { unreadable: typeof code === 'string' ? code : String(error) }
  }
}

/**
 * Whether the store's mail domain says who may send for it: a DMARC record for every delivering provider, and an SPF
 * record when the store sends over its own SMTP (a hosted provider such as Resend or SES puts SPF on its own return-path
 * domain). DKIM needs the provider's selector, so it is not looked up. Read-only: one DNS query per record, and none on
 * a developer's store or one whose mail only reaches the log.
 */
export async function mailDomainCheck(
  config: NymbalConfig,
  env: Record<string, string | undefined>,
  resolveTxt: ResolveTxt = dns.resolveTxt,
): Promise<DiagnosisCheck> {
  if (!secureCookies(config, env)) {
    return { name: MAIL_DOMAIN, status: 'ok', detail: 'not checked: not an https store' }
  }
  if (!delivers(config)) {
    return {
      name: MAIL_DOMAIN,
      status: 'ok',
      detail: 'not checked: the native email provider only logs',
    }
  }
  const domain = mailDomainOf(config)
  if (domain === null) {
    return { name: MAIL_DOMAIN, status: 'ok', detail: 'not checked: no from address or store.url' }
  }
  const records: Array<{ record: string; at: string; prefix: RegExp }> = [
    { record: 'DMARC', at: `_dmarc.${domain}`, prefix: /^v=DMARC1\b/i },
  ]
  if (config.commerce.email.provider === 'smtp') {
    records.push({ record: 'SPF', at: domain, prefix: /^v=spf1\b/i })
  }
  const problems: string[] = []
  for (const { record, at, prefix } of records) {
    const result = await lookup(resolveTxt, at, prefix)
    if ('unreadable' in result)
      problems.push(`could not read the ${record} record at ${at} (${result.unreadable})`)
    else if (!result.found) problems.push(`no ${record} record at ${at}`)
  }
  if (problems.length > 0) {
    return {
      name: MAIL_DOMAIN,
      status: 'degraded',
      detail: `${problems.join('; ')}: receiving servers may take this store's mail for spam`,
    }
  }
  return {
    name: MAIL_DOMAIN,
    status: 'ok',
    detail: `${domain}: ${records.map((r) => r.record).join(' and ')} found`,
  }
}
