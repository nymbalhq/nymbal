import type { NymbalConfig } from '@nymbalhq/config'

// The admin dashboard's mail warning, from what the API knows without a DNS lookup (the SPF and DMARC read is
// `nymbal doctor`'s): where the store's SMTP goes, its sign-up policy, and how many of its sign-ups confirmed.

/** Sign-ups asked to confirm in the last `days` days (bar the last hour), and how many did. */
export interface MailFunnel {
  days: number
  started: number
  verified: number
}

export interface MailWarningInput {
  verification: 'required' | 'off'
  /** `secureCookies(config, env)`: a real deployment, not a developer's store. */
  secure: boolean
  localSmtp: boolean
  /** Whether the email adapter reaches a mailbox: what the `off` warning tells the owner to do next. */
  delivers: boolean
  /** Null under `off`, which asks nobody to confirm. */
  funnel: MailFunnel | null
}

/** Below this many sign-ups in the window, a low confirmation rate is noise, not lost mail. */
const FUNNEL_MIN_STARTED = 10

const ADD_PROVIDER = 'or an email provider (`nymbal add email-resend`)'

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\])$/i

/** Whether the store sends over SMTP to its own machine, whose mail a receiving server is likely to take for spam. */
export function localSmtp(config: NymbalConfig): boolean {
  const { email } = config.commerce
  if (email.provider !== 'smtp') return false
  const smtp = (email.config as { smtp?: { host?: unknown } } | undefined)?.smtp
  if (typeof smtp?.host !== 'string') return false
  const host = smtp.host.trim().toLowerCase()
  // `store.url` is a URL by the config schema.
  const storeHost = config.store.url === undefined ? null : new URL(config.store.url).hostname
  return LOOPBACK.test(host) || host === storeHost
}

/** The first problem that applies, or null. */
export function mailWarning(input: MailWarningInput): string | null {
  const { verification, secure, funnel } = input
  if (input.localSmtp && secure) {
    return `Mail from this server may be rejected as spam. Add SPF and DKIM for your domain, ${ADD_PROVIDER}.`
  }
  if (
    verification === 'required' &&
    funnel !== null &&
    funnel.started >= FUNNEL_MIN_STARTED &&
    2 * funnel.verified < funnel.started
  ) {
    const unconfirmed = funnel.started - funnel.verified
    return `Mail from this store may not be arriving. ${unconfirmed} of ${funnel.started} sign-ups in the last ${funnel.days} days never confirmed their email. Add SPF and DKIM for your domain, ${ADD_PROVIDER}.`
  }
  if (verification === 'off' && secure) {
    const next = input.delivers
      ? 'Set `security.auth.verification` to `required`.'
      : 'Add an email provider (`nymbal add email-resend`).'
    return `Sign-ups are not confirmed by email, so registering shows whether an address has an account. ${next}`
  }
  return null
}
