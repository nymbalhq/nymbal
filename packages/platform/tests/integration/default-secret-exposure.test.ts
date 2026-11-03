import { randomBytes } from 'node:crypto'
import { SignJWT } from 'jose'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_JWT_SECRET, type NymbalConfig } from '@nymbalhq/config'
import { createHttpServer } from '../../../http/src/index.js'
import { createNativeStubPaymentsAdapter } from '../../src/adapters/payments/native-stub.js'
import { JWT_SECRET_ENV } from '../../src/auth-secret.js'
import { createLogger } from '../../src/logger.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel } from '../support/kernel.js'
import { adminClient } from '../support/money.js'

// Anyone can sign a token with the schema's published default secret, so a store using it must not be reachable from
// another machine, whatever NODE_ENV says: attaching HTTP refuses a non-loopback host when the secret is the default.
// Production keeps its own, earlier refusal at createApp on any host. A store with a secret of its own refuses a
// token forged with the default secret.

type Outcome = 'served' | string

interface Cell {
  secret: 'default' | 'env'
  host: '0.0.0.0' | '127.0.0.1'
  nodeEnv: undefined | 'staging' | 'production'
}

const CELLS: Cell[] = [
  { secret: 'default', host: '0.0.0.0', nodeEnv: undefined },
  { secret: 'default', host: '0.0.0.0', nodeEnv: 'staging' },
  { secret: 'default', host: '127.0.0.1', nodeEnv: undefined },
  { secret: 'default', host: '127.0.0.1', nodeEnv: 'staging' },
  { secret: 'env', host: '0.0.0.0', nodeEnv: undefined },
  { secret: 'default', host: '0.0.0.0', nodeEnv: 'production' },
  { secret: 'default', host: '127.0.0.1', nodeEnv: 'production' },
]

function predicted(cell: Cell): Outcome {
  if (cell.secret === 'default' && cell.nodeEnv === 'production') {
    return 'ConfigError:config.production_default_jwt_secret'
  }
  if (cell.secret === 'default' && cell.host === '0.0.0.0') {
    return 'ConfigError:config.default_jwt_secret_exposed'
  }
  return 'served'
}

/**
 * A `custom` payments slot holding an adapter that is not the stub, so production judges only the secret and no
 * payments package is resolved.
 */
function shaped(host: string) {
  return (config: NymbalConfig): NymbalConfig => ({
    ...config,
    http: { ...config.http, host },
    commerce: { ...config.commerce, payments: { provider: 'custom' } },
  })
}

function ownPayments() {
  return {
    ...createNativeStubPaymentsAdapter({ logger: createLogger({ pretty: false, level: 'error' }) }),
    providerName: 'exposure-suite-payments',
  }
}

const saved = { NODE_ENV: process.env.NODE_ENV, [JWT_SECRET_ENV]: process.env[JWT_SECRET_ENV] }
const open: Array<{ stop(): Promise<void> }> = []

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(async () => {
  for (const s of open.splice(0)) await s.stop()
  for (const [key, value] of Object.entries(saved)) setEnv(key, value)
})

function described(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}:${(error as { code?: string }).code ?? error.message}`
  }
  return String(error)
}

/** createApp, then attachHttp on an adapter that is never started: the first refusal, or `served`. */
async function attach(cell: Cell): Promise<Outcome> {
  setEnv('NODE_ENV', cell.nodeEnv)
  setEnv(JWT_SECRET_ENV, cell.secret === 'env' ? randomBytes(32).toString('base64url') : undefined)
  let kernel
  try {
    kernel = await createKernel({
      dialect: 'sqlite',
      configure: shaped(cell.host),
      appOptions: { adapters: { payments: ownPayments() } },
    })
  } catch (error) {
    return described(error)
  }
  open.push({ stop: () => kernel.close() })
  const http = createHttpServer({
    config: kernel.config,
    logger: kernel.logger,
    documentStore: kernel.documentStore,
    version: '0.0.0',
  })
  try {
    await kernel.app.attachHttp(http.adapter)
    return 'served'
  } catch (error) {
    return described(error)
  }
}

describe('AC-9: the default secret is never served beyond loopback', () => {
  it('AC-9: attachHttp refuses with config.default_jwt_secret_exposed exactly when the secret is the default and the host is not loopback, under NODE_ENV unset and staging; production refuses the default at createApp on either host', async () => {
    const observed: Outcome[] = []
    for (const cell of CELLS) observed.push(await attach(cell))

    expect(CELLS.map((c, i) => ({ ...c, outcome: observed[i] }))).toEqual(
      CELLS.map((c) => ({ ...c, outcome: predicted(c) })),
    )
  }, 120_000)

  it('AC-9: on a store whose secret is NYMBAL_JWT_SECRET, an admin access token forged with the default secret answers 401 from GET /api/admin/settings, where the admin’s own token answers 200', async () => {
    setEnv('NODE_ENV', undefined)
    setEnv(JWT_SECRET_ENV, randomBytes(32).toString('base64url'))
    const s: ServedKernel = await serveKernel(await createKernel({ dialect: 'sqlite' }))
    open.push(s)
    const admin = await adminClient(s.kernel, s.baseUrl)
    const forged = await new SignJWT({ sub: admin.userId, roles: ['admin'], type: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('nymbal')
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(DEFAULT_JWT_SECRET))

    const own = await admin.call('GET', '/api/admin/settings')
    const res = await fetch(`${s.baseUrl}/api/admin/settings`, {
      headers: { accept: 'application/json', authorization: `Bearer ${forged}` },
    })
    const body = (await res.json()) as { error?: { code: string } }

    expect(own.status).toBe(200)
    expect(res.status).toBe(401)
    expect(body.error?.code).toMatch(/^auth\./)
  }, 60_000)
})
