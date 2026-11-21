import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { localSmtp, mailWarning } from './mail-health.js'

// The admin dashboard's mail warning, from what the API knows without a DNS lookup: a store that sends from its own
// server (SMTP to itself) on a real deployment, a store whose sign-ups mostly never confirm (at least 10 in the
// window and fewer than half confirmed), and a real deployment that does not confirm sign-ups at all. The first that
// applies is the one shown; a quiet store or a developer's shows none.

const SPAM =
  'Mail from this server may be rejected as spam. Add SPF and DKIM for your domain, or an email provider (`nymbal add email-resend`).'
const OFF =
  'Sign-ups are not confirmed by email, so registering shows whether an address has an account.'
const OFF_NATIVE = ' Add an email provider (`nymbal add email-resend`).'
const OFF_DELIVERING = ' Set `security.auth.verification` to `required`.'
const notArriving = (n: number, m: number) =>
  `Mail from this store may not be arriving. ${n} of ${m} sign-ups in the last 7 days never confirmed their email. Add SPF and DKIM for your domain, or an email provider (\`nymbal add email-resend\`).`

/** 0 ≤ verified ≤ started ≤ 200. */
const funnel = fc
  .integer({ min: 0, max: 200 })
  .chain((started) =>
    fc.integer({ min: 0, max: started }).map((verified) => ({ days: 7, started, verified })),
  )

describe('AC-13: the warning names the first problem that applies', () => {
  // Defect: the warning fires on a quiet store's first sign-up, never fires on a store whose mail is lost or that
  // sends from its own server, or fires on a developer's store.
  it('AC-13: property: over 0 ≤ verified ≤ started ≤ 200, both policies, secure, localSmtp and delivery, mailWarning is the SMTP text exactly when localSmtp and secure; else "N of M" exactly when required, started ≥ 10 and 2 × verified < started; else the off text exactly when off and secure; else null', () => {
    fc.assert(
      fc.property(
        funnel,
        fc.constantFrom<'required' | 'off'>('required', 'off'),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (f, verification, secure, isLocal, delivers) => {
          const warning = mailWarning({
            verification,
            secure,
            localSmtp: isLocal,
            delivers,
            funnel: f,
          })

          const expected =
            isLocal && secure
              ? SPAM
              : verification === 'required' && f.started >= 10 && 2 * f.verified < f.started
                ? notArriving(f.started - f.verified, f.started)
                : verification === 'off' && secure
                  ? `${OFF}${delivers ? OFF_DELIVERING : OFF_NATIVE}`
                  : null
          expect(warning, JSON.stringify({ f, verification, secure, isLocal, delivers })).toBe(
            expected,
          )
        },
      ),
      {
        numRuns: 400,
        examples: [
          [{ days: 7, started: 10, verified: 4 }, 'required', false, false, true],
          [{ days: 7, started: 10, verified: 5 }, 'required', false, false, true],
          [{ days: 7, started: 9, verified: 0 }, 'required', true, false, true],
          [{ days: 7, started: 12, verified: 5 }, 'required', true, true, true],
        ],
      },
    )
  })

  // Defect: under `off` the funnel is read anyway, so a store that never asks warns that mail is lost.
  it('AC-13: under off with no funnel, the warning is the off text on a secure store and null on a developer’s', () => {
    const answers = [true, false].map((secure) =>
      mailWarning({ verification: 'off', secure, localSmtp: false, delivers: false, funnel: null }),
    )

    expect(answers).toEqual([`${OFF}${OFF_NATIVE}`, null])
  })
})

function configOf(email: Record<string, unknown>): NymbalConfig {
  return nymbalConfigSchema.parse({
    store: {
      name: 'Mail Store',
      currency: 'GBP',
      locale: 'en-GB',
      timezone: 'Europe/London',
      url: 'https://shop.example',
    },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware' },
    commerce: {
      payments: { provider: 'native' },
      email,
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3001, host: '0.0.0.0' },
    deployment: { strategy: 'standard' },
  })
}

const smtp = (host: string) => ({
  provider: 'smtp',
  config: { from: 'Shop <orders@shop.example>', smtp: { host, port: 587 } },
})

describe('AC-13: localSmtp reads where the store’s SMTP goes', () => {
  // Defect: a store relaying to itself is not seen, or a relay or a hosted provider is taken for one.
  it('AC-13: smtp.host localhost, 127.0.0.1, ::1 and the store’s own host are local; a relay host and the mailgun provider pointed at 127.0.0.1 are not', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['localhost', smtp('localhost')],
      ['127.0.0.1', smtp('127.0.0.1')],
      ['::1', smtp('::1')],
      ['the store’s host', smtp('shop.example')],
      ['a relay', smtp('smtp.relay.example')],
      [
        'mailgun',
        {
          provider: 'mailgun',
          config: { from: 'orders@shop.example', smtp: { host: '127.0.0.1', port: 1025 } },
        },
      ],
    ]

    const read = cases.map(([name, email]) => [name, localSmtp(configOf(email))])

    expect(read).toEqual([
      ['localhost', true],
      ['127.0.0.1', true],
      ['::1', true],
      ['the store’s host', true],
      ['a relay', false],
      ['mailgun', false],
    ])
  })
})
