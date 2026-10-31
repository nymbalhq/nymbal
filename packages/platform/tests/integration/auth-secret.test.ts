import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { jwtVerify } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_JWT_SECRET, type NymbalConfig } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'
import { scrub } from '../../src/settings/secret-set.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { adminClient } from '../support/money.js'
import { captureLogs, stringsIn } from '../support/settings.js'

// One process, one JWT secret: the effective one (the config's own, else NYMBAL_JWT_SECRET, else the default) signs
// the shopper's access token and the admin event-stream ticket, is what production refuses when it is the default,
// and joins the secret set every log is scrubbed of.

const VARIABLE = 'NYMBAL_JWT_SECRET'
const PASSWORD = 'correct-horse-battery'

/** A secret of the kind create-nymbal-app writes: 32 random bytes, base64url. */
function newSecret(): string {
  return randomBytes(32).toString('base64url')
}

function withJwtSecret(config: NymbalConfig, jwtSecret: string): NymbalConfig {
  return {
    ...config,
    security: { ...config.security, auth: { ...config.security.auth, jwtSecret } },
  }
}

function withStripe(config: NymbalConfig): NymbalConfig {
  return {
    ...config,
    commerce: {
      ...config.commerce,
      payments: {
        provider: 'stripe',
        config: { secretKey: 'sk_test_never_called', webhookSecret: 'whsec_never_called' },
      },
    },
  }
}

/** The `sub` of an access token that verifies under `secret`, or null when it does not. */
async function subjectUnder(token: string, secret: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret))
    return payload.sub ?? null
  } catch {
    return null
  }
}

/** Whether an event-stream ticket (`<body>.<hmac-sha256 base64url>`) is signed with `secret`. */
function ticketSignedWith(ticket: string, secret: string): boolean {
  const [body, sig] = ticket.split('.')
  return (
    body !== undefined &&
    sig !== undefined &&
    createHmac('sha256', secret).update(body).digest('base64url') === sig
  )
}

const savedEnv = { NODE_ENV: process.env.NODE_ENV, [VARIABLE]: process.env[VARIABLE] }
const open: Array<{ stop(): Promise<void> }> = []

function setVariable(value: string | undefined): void {
  if (value === undefined) delete process.env[VARIABLE]
  else process.env[VARIABLE] = value
}

afterEach(async () => {
  for (const s of open.splice(0)) await s.stop()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

async function served(configure?: (c: NymbalConfig) => NymbalConfig): Promise<ServedKernel> {
  const kernel = await createKernel({ dialect: 'sqlite', ...(configure && { configure }) })
  const s = await serveKernel(kernel)
  open.push(s)
  return s
}

/** createApp's outcome: the kernel it built, or the error it rejected with. */
async function attempt(configure: (c: NymbalConfig) => NymbalConfig): Promise<Kernel | unknown> {
  try {
    const kernel = await createKernel({ dialect: 'sqlite', configure })
    open.push({ stop: () => kernel.close() })
    return kernel
  } catch (error) {
    return error
  }
}

describe('AC-2: tokens sign with the effective secret', () => {
  it('AC-2: with the config at the default and NYMBAL_JWT_SECRET=S, a registered shopper’s access token and the admin event ticket verify under S and not under the default; with no variable and an own config secret C, both verify under C', async () => {
    const S = newSecret()
    const C = newSecret()
    const cases = [
      { variable: S, configure: undefined, effective: S },
      { variable: undefined, configure: (c: NymbalConfig) => withJwtSecret(c, C), effective: C },
    ]

    const results = []
    for (const c of cases) {
      setVariable(c.variable)
      const s = await served(c.configure)
      const { customer, tokens } = await s.kernel.services.auth.register({
        email: `jwt-${randomUUID()}@secret.test`,
        password: PASSWORD,
      })
      const admin = await adminClient(s.kernel, s.baseUrl)
      const ticket = await admin.call<{ ticket: string }>('POST', '/api/admin/events/ticket')
      const raw = ticket.body.data?.ticket ?? ''
      results.push({
        customer: customer.id,
        ticketStatus: ticket.status,
        underEffective: await subjectUnder(tokens.accessToken, c.effective),
        underDefault: await subjectUnder(tokens.accessToken, DEFAULT_JWT_SECRET),
        ticketUnderEffective: ticketSignedWith(raw, c.effective),
        ticketUnderDefault: ticketSignedWith(raw, DEFAULT_JWT_SECRET),
      })
    }

    expect(results.map((r) => r.ticketStatus)).toEqual([200, 200])
    expect(results.map((r) => r.underEffective)).toEqual(results.map((r) => r.customer))
    expect(results.map((r) => r.underDefault)).toEqual([null, null])
    expect(results.map((r) => r.ticketUnderEffective)).toEqual([true, true])
    expect(results.map((r) => r.ticketUnderDefault)).toEqual([false, false])
  })
})

describe('AC-3: production boots on the env secret', () => {
  it('AC-3: under NODE_ENV=production with the stripe adapter and the config at the default secret, createApp builds and serves with NYMBAL_JWT_SECRET set, and without it throws config.production_default_jwt_secret', async () => {
    process.env.NODE_ENV = 'production'
    setVariable(undefined)
    const refused = await attempt(withStripe)

    setVariable(newSecret())
    let failure: string | null = null
    let listing: number | null = null
    try {
      const s = await served(withStripe)
      listing = (await fetch(`${s.baseUrl}/api/products`)).status
    } catch (error) {
      failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }

    expect(refused).toBeInstanceOf(ConfigError)
    expect((refused as ConfigError).code).toBe('config.production_default_jwt_secret')
    expect(failure).toBeNull()
    expect(listing).toBe(200)
  })

  it('AC-3: after createApp, scrub removes the effective secret, whether it came from NYMBAL_JWT_SECRET or from the config’s own, and left the text whole before', async () => {
    process.env.NODE_ENV = 'production'
    const S = newSecret()
    const C = newSecret()
    const text = (secret: string) => `a ${secret} b`
    const before = [scrub(text(S)), scrub(text(C))]

    setVariable(S)
    const fromEnv = await attempt(withStripe)
    const afterEnv = scrub(text(S))
    setVariable(undefined)
    const fromConfig = await attempt((c) => withJwtSecret(withStripe(c), C))
    const afterConfig = scrub(text(C))

    expect(before).toEqual([text(S), text(C)])
    expect(fromConfig instanceof Error ? String(fromConfig) : null).toBeNull()
    expect(afterConfig).toBe('a *** b')
    expect(fromEnv instanceof Error ? String(fromEnv) : null).toBeNull()
    expect(afterEnv).toBe('a *** b')
  })
})

describe('AC-1: a shadowed variable warns once, with no value', () => {
  it('AC-1: with an own config secret C and NYMBAL_JWT_SECRET=S ≠ C, createApp logs one warn naming NYMBAL_JWT_SECRET and holding neither value, and tokens sign with C; with S = C or no variable it logs none', async () => {
    const C = newSecret()
    const S = newSecret()
    const cases = [
      { variable: S, warns: 1 },
      { variable: C, warns: 0 },
      { variable: undefined, warns: 0 },
    ]

    const results = []
    for (const c of cases) {
      setVariable(c.variable)
      const logs = captureLogs()
      const kernel = await createKernel({
        dialect: 'sqlite',
        configure: (cfg) => withJwtSecret(cfg, C),
        logger: logs.logger,
      })
      open.push({ stop: () => kernel.close() })
      const { customer, tokens } = await kernel.services.auth.register({
        email: `shadow-${randomUUID()}@secret.test`,
        password: PASSWORD,
      })
      const warns = logs.calls.filter(
        (call) =>
          call.level === 'warn' &&
          stringsIn([call.obj, call.msg ?? '']).some((s) => s.includes(VARIABLE)),
      )
      const warnText = stringsIn(warns.map((w) => [w.obj, w.msg ?? ''])).join('\n')
      results.push({
        warns: warns.length,
        // A value the scrubbing logger caught shows as its mask: that is a value the warn tried to hold.
        leaked: [C, S, '***'].filter((v) => warnText.includes(v)),
        signedWithConfig: (await subjectUnder(tokens.accessToken, C)) === customer.id,
      })
    }

    expect(results.map((r) => r.warns)).toEqual(cases.map((c) => c.warns))
    expect(results.flatMap((r) => r.leaked)).toEqual([])
    expect(results.map((r) => r.signedWithConfig)).toEqual(cases.map(() => true))
  })
})
