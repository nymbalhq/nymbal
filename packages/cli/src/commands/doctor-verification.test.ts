import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { mailDomainCheck, verificationCheck } from './doctor-verification.js'

// `nymbal doctor` on a real deployment (its cookies are Secure) says what its sign-up policy gives up: `email
// verification` is degraded where nobody can confirm (no provider that delivers, or no store URL to link to) or where
// registering shows which addresses have accounts (`off`). `mail domain` reads the from-address's domain's DMARC record,
// and for a store sending over its own SMTP its SPF record, through an injected resolver; on a developer's store or a
// `native` one it looks nothing up.

type Policy = 'required' | 'off' | undefined
type Url = 'https' | 'http' | 'none'

const HTTPS = 'https://shop.example'
const HTTP = 'http://localhost:4321'

interface Shape {
  policy?: Policy
  provider?: 'native' | 'smtp' | 'resend'
  url?: Url
  from?: string
}

function configOf({ policy, provider = 'native', url = 'https', from }: Shape): NymbalConfig {
  const email =
    provider === 'native'
      ? { provider: 'native' }
      : provider === 'smtp'
        ? {
            provider: 'smtp',
            config: {
              ...(from !== undefined && { from }),
              smtp: { host: 'smtp.relay.example', port: 587 },
            },
          }
        : {
            provider: 'resend',
            config: { apiKey: 're_test_key', ...(from !== undefined && { from }) },
          }
  return nymbalConfigSchema.parse({
    store: {
      name: 'Doctor Store',
      currency: 'GBP',
      locale: 'en-GB',
      timezone: 'Europe/London',
      ...(url !== 'none' && { url: url === 'https' ? HTTPS : HTTP }),
    },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware', auth: policy === undefined ? {} : { verification: policy } },
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

describe('AC-14: doctor names a sign-up policy nobody can complete or that enumerates', () => {
  // Defect: doctor stays green on a store where nobody can confirm, or where registration is enumerable.
  it('AC-14: property: email verification is degraded exactly on a Secure store whose resolved policy is off, or that requires a link with a native provider or with no store.url; otherwise ok, and an ok line on a Secure store names the policy', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Policy>('required', 'off', undefined),
        fc.constantFrom<'native' | 'smtp'>('native', 'smtp'),
        fc.constantFrom<Url>('https', 'http', 'none'),
        fc.boolean(),
        (policy, provider, url, production) => {
          const env = production ? { NODE_ENV: 'production' } : {}
          const check = verificationCheck(configOf({ policy, provider, url }), env)

          const secure = url === 'https' || (url === 'none' && production)
          const resolved = policy ?? (provider === 'native' ? 'off' : 'required')
          const degraded = secure && (resolved === 'off' || provider === 'native' || url === 'none')
          const label = JSON.stringify({ policy, provider, url, production })
          expect(check.name).toBe('email verification')
          expect(check.status, label).toBe(degraded ? 'degraded' : 'ok')
          // An ok line on a Secure store says which policy it found.
          expect(!secure || degraded || (check.detail ?? '').includes(resolved), label).toBe(true)
        },
      ),
      {
        numRuns: 150,
        examples: [
          ['off', 'smtp', 'https', false],
          [undefined, 'native', 'https', false],
          ['required', 'native', 'https', false],
          ['required', 'smtp', 'none', true],
          ['required', 'smtp', 'https', false],
          ['off', 'native', 'http', true],
        ],
      },
    )
  })
})

interface Records {
  spf: boolean
  dmarc: boolean
}

/** A resolver that answers the domain's TXT and its `_dmarc` TXT as `records` says, recording every name asked. */
function resolverFor(domain: string, records: Records) {
  const asked: string[] = []
  const resolveTxt = async (name: string): Promise<string[][]> => {
    asked.push(name)
    if (name === `_dmarc.${domain}`) return records.dmarc ? [['v=DMARC1; p=quarantine']] : []
    if (name === domain) {
      return [
        ['google-site-verification=abc'],
        ...(records.spf ? [['v=spf1 include:_spf.example ~all']] : []),
      ]
    }
    return []
  }
  return { asked, resolveTxt }
}

const fromShapes = [
  { from: 'orders@acme.com', domain: 'acme.com' },
  { from: 'Acme <orders@acme.com>', domain: 'acme.com' },
  { from: undefined, domain: 'shop.example' },
] as const

describe('AC-15: doctor reads the mail domain’s records', () => {
  // Defect: the check reads the wrong domain, reports a missing record as present, or marks a healthy hosted-provider
  // store degraded.
  it('AC-15: property: on an https store, the domain is the from-address’s (a display-name form included) or else the store URL’s host; DMARC is read for every delivering provider and SPF only for smtp; the line is degraded exactly when DMARC is missing or (on smtp) SPF is, naming each missing record', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'smtp' | 'resend'>('smtp', 'resend'),
        fc.constantFrom(...fromShapes),
        fc.boolean(),
        fc.boolean(),
        async (provider, shape, spf, dmarc) => {
          const { asked, resolveTxt } = resolverFor(shape.domain, { spf, dmarc })
          const config = configOf({
            provider,
            url: 'https',
            ...(shape.from !== undefined && { from: shape.from }),
          })

          const check = await mailDomainCheck(config, {}, resolveTxt)

          const label = JSON.stringify({
            provider,
            from: shape.from,
            spf,
            dmarc,
            detail: check.detail,
          })
          const missingSpf = provider === 'smtp' && !spf
          expect(check.name).toBe('mail domain')
          expect(check.status, label).toBe(!dmarc || missingSpf ? 'degraded' : 'ok')
          const detail = check.detail ?? ''
          expect(
            {
              dmarcNamed: dmarc || /DMARC/.test(detail),
              spfNamed: !missingSpf || /SPF/.test(detail),
              dmarcRead: asked.includes(`_dmarc.${shape.domain}`),
              spfRead: provider !== 'smtp' || asked.includes(shape.domain),
              otherNames: asked.filter((name) => name !== shape.domain && name !== `_dmarc.${shape.domain}`),
            },
            label,
          ).toEqual({ dmarcNamed: true, spfNamed: true, dmarcRead: true, spfRead: true, otherNames: [] })
        },
      ),
      {
        numRuns: 60,
        examples: [
          ['resend', fromShapes[0], false, true],
          ['smtp', fromShapes[1], false, true],
          ['smtp', fromShapes[2], true, false],
        ],
      },
    )
  })

  // Defect: a failed lookup is read as a missing or a present record.
  it('AC-15: a lookup that throws makes the line degraded, saying it could not read the record', async () => {
    const config = configOf({ provider: 'resend', url: 'https', from: 'orders@acme.com' })
    const resolveTxt = async (): Promise<string[][]> => {
      throw Object.assign(new Error('queryTxt ETIMEOUT _dmarc.acme.com'), { code: 'ETIMEOUT' })
    }

    const check = await mailDomainCheck(config, {}, resolveTxt)

    expect([check.name, check.status]).toEqual(['mail domain', 'degraded'])
    expect(check.detail).toMatch(/could not read/)
  })

  // Defect: doctor makes a DNS lookup on a developer's store, or on one whose mail only reaches the log.
  it('AC-15: on an http store with a delivering provider, and on an https store with the native provider, the line is ok "not checked" and the resolver is never called', async () => {
    const lines = []
    const asked: string[] = []
    const resolveTxt = async (name: string): Promise<string[][]> => {
      asked.push(name)
      return []
    }
    for (const config of [
      configOf({ provider: 'smtp', url: 'http', from: 'orders@acme.com' }),
      configOf({ provider: 'native', url: 'https' }),
    ]) {
      lines.push(await mailDomainCheck(config, {}, resolveTxt))
    }

    expect(lines.map((l) => [l.name, l.status])).toEqual([
      ['mail domain', 'ok'],
      ['mail domain', 'ok'],
    ])
    expect(lines.map((l) => /not checked/.test(l.detail ?? ''))).toEqual([true, true])
    expect(asked).toEqual([])
  })
})
