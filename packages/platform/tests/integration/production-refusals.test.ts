import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'
import { createNativeStubPaymentsAdapter } from '../../src/adapters/payments/native-stub.js'
import { createApp, type NymbalApp } from '../../src/app.js'
import { JWT_SECRET_ENV } from '../../src/auth-secret.js'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createLogger } from '../../src/logger.js'
import { kernelConfig, MIGRATIONS_ROOT } from '../support/kernel.js'

// AC-8: a production process refuses the stub payments adapter and the schema's default JWT secret before it opens
// the store; development and test are unchanged.
//
// The refusal reads the resolved payments adapter, not the config string, so a `custom` slot is judged by the adapter
// injected into it: the native stub injected is refused before the store directory is touched, a real adapter
// injected starts. An unregistered provider string never reaches createApp: loadConfig rejects it
// (packages/config/src/known-providers.test.ts).

const DEFAULT_JWT_SECRET = 'dev-secret-please-override-me-1234567890'
const logger = createLogger({ pretty: false, level: 'error' })

function withStripe(config: NymbalConfig): NymbalConfig {
  return {
    ...config,
    commerce: {
      ...config.commerce,
      payments: {
        provider: 'stripe',
        config: { secretKey: 'sk_test_webhook_never_called', webhookSecret: 'whsec_webhook' },
      },
    },
  }
}

function withCustomPayments(config: NymbalConfig): NymbalConfig {
  return { ...config, commerce: { ...config.commerce, payments: { provider: 'custom' } } }
}

/** A real payments adapter of the project's own: not the stub, whatever it wraps. */
function ownPaymentsAdapter() {
  return {
    ...createNativeStubPaymentsAdapter({ logger }),
    providerName: 'adapters-own-payments',
    capabilities: () => ['intent', 'capture', 'refund'],
  }
}

function withJwtSecret(config: NymbalConfig, jwtSecret: string): NymbalConfig {
  return {
    ...config,
    security: { ...config.security, auth: { ...config.security.auth, jwtSecret } },
  }
}

describe('production refusals at createApp', () => {
  const dirs: string[] = []
  const apps: NymbalApp[] = []
  const nodeEnv = process.env.NODE_ENV
  const envSecret = process.env[JWT_SECRET_ENV]

  // Every case names its secret in the config or means the schema default: a secret the shell exports would replace
  // the default and turn a refusal into a start.
  beforeEach(() => {
    delete process.env[JWT_SECRET_ENV]
  })

  afterEach(async () => {
    if (nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnv
    if (envSecret === undefined) delete process.env[JWT_SECRET_ENV]
    else process.env[JWT_SECRET_ENV] = envSecret
    for (const app of apps.splice(0)) await app.stop()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function storePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'webhook-prod-'))
    dirs.push(dir)
    return join(dir, 'store.sqlite')
  }

  async function migrated(config: NymbalConfig, sqlitePath: string): Promise<void> {
    const store = createCommandStore(config, { sqlitePath })
    try {
      await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
    } finally {
      await store.close()
    }
  }

  /** createApp's outcome: the error it rejected with, or null when it started (the app is stopped afterwards). */
  async function attempt(
    config: NymbalConfig,
    sqlitePath: string,
    adapters?: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      apps.push(await createApp(config, { sqlitePath, logger, ...(adapters && { adapters }) }))
      return null
    } catch (error) {
      return error
    }
  }

  it('AC-8: NODE_ENV=production with payments provider native rejects with ConfigError config.production_stub_payments before any store file is created', async () => {
    process.env.NODE_ENV = 'production'
    const sqlitePath = storePath()
    const config = withJwtSecret(kernelConfig('sqlite'), 'webhook-production-secret-0123456789')
    expect(config.commerce.payments.provider).toBe('native')

    const error = await attempt(config, sqlitePath)

    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).code).toBe('config.production_stub_payments')
    expect((error as ConfigError).message).toContain('native')
    expect(existsSync(sqlitePath)).toBe(false)
  })

  it('AC-8: NODE_ENV=production with the default JWT secret rejects with ConfigError config.production_default_jwt_secret before any store file is created', async () => {
    process.env.NODE_ENV = 'production'
    const sqlitePath = storePath()
    const config = withStripe(kernelConfig('sqlite'))
    expect(config.security.auth.jwtSecret).toBe(DEFAULT_JWT_SECRET)

    const error = await attempt(config, sqlitePath)

    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).code).toBe('config.production_default_jwt_secret')
    expect(existsSync(sqlitePath)).toBe(false)
  })

  it('AC-8: NODE_ENV=production with a real payments provider and a non-default JWT secret starts', async () => {
    process.env.NODE_ENV = 'production'
    const sqlitePath = storePath()
    const config = withJwtSecret(
      withStripe(kernelConfig('sqlite')),
      'webhook-production-secret-0123456789',
    )
    await migrated(config, sqlitePath)

    expect(await attempt(config, sqlitePath)).toBeNull()
    expect(existsSync(sqlitePath)).toBe(true)
  })

  it('AC-8: NODE_ENV=production with payments custom and a real adapter injected starts', async () => {
    process.env.NODE_ENV = 'production'
    const sqlitePath = storePath()
    const config = withJwtSecret(
      withCustomPayments(kernelConfig('sqlite')),
      'webhook-production-secret-0123456789',
    )
    await migrated(config, sqlitePath)

    expect(await attempt(config, sqlitePath, { payments: ownPaymentsAdapter() })).toBeNull()
    expect(apps.at(-1)?.adapters.payments.providerName).toBe(ownPaymentsAdapter().providerName)
  })

  // The resolved stub is refused whether the registry built it (`native`) or the project injected it into a `custom`
  // slot, and before the store is opened.
  it('AC-8: in production every stub-or-default-secret cell is refused with a code its cell predicts and leaves the store directory as it found it', async () => {
    process.env.NODE_ENV = 'production'
    const CUSTOM_SECRET = 'webhook-production-secret-0123456789'
    type Payments = 'native' | 'custom-stub' | 'custom-own' | 'stripe'
    const cells: Array<{ payments: Payments; secret: string }> = [
      { payments: 'native', secret: CUSTOM_SECRET },
      { payments: 'native', secret: DEFAULT_JWT_SECRET },
      { payments: 'custom-stub', secret: CUSTOM_SECRET },
      { payments: 'custom-stub', secret: DEFAULT_JWT_SECRET },
      { payments: 'custom-own', secret: DEFAULT_JWT_SECRET },
      { payments: 'stripe', secret: DEFAULT_JWT_SECRET },
    ]

    /** The refusal codes a cell may answer with; createApp throws one of them. */
    function predictedCodes(cell: { payments: Payments; secret: string }): string[] {
      const codes: string[] = []
      if (cell.payments === 'native' || cell.payments === 'custom-stub') {
        codes.push('config.production_stub_payments')
      }
      if (cell.secret === DEFAULT_JWT_SECRET) codes.push('config.production_default_jwt_secret')
      return codes
    }

    const results = []
    for (const cell of cells) {
      const sqlitePath = storePath()
      const dir = dirname(sqlitePath)
      const base = kernelConfig('sqlite')
      const shaped =
        cell.payments === 'stripe'
          ? withStripe(base)
          : cell.payments === 'native'
            ? base
            : withCustomPayments(base)
      const injected =
        cell.payments === 'custom-stub'
          ? { payments: createNativeStubPaymentsAdapter({ logger }) }
          : cell.payments === 'custom-own'
            ? { payments: ownPaymentsAdapter() }
            : undefined
      const config = withJwtSecret(shaped, cell.secret)
      const filesBefore = readdirSync(dir).sort()
      const error = await attempt(config, sqlitePath, injected)
      const filesAfter = readdirSync(dir).sort()
      results.push({ cell, error, filesBefore, filesAfter })
    }

    const unpredicted = results
      .filter(({ cell, error }) => {
        if (!(error instanceof ConfigError)) return true
        if (!predictedCodes(cell).includes(error.code)) return true
        // A stub refusal names the configured provider, not a hard-coded 'native'.
        const configured = cell.payments === 'custom-stub' ? 'custom' : cell.payments
        return (
          error.code === 'config.production_stub_payments' && !error.message.includes(configured)
        )
      })
      .map(({ cell, error }) => ({ cell, error: String(error) }))
    expect(unpredicted).toEqual([])
    expect(results.map((r) => r.filesAfter)).toEqual(results.map((r) => r.filesBefore))
  })

  it('AC-8: with NODE_ENV unset, the stub provider and the default JWT secret both start as today', async () => {
    delete process.env.NODE_ENV
    const sqlitePath = storePath()
    const config = kernelConfig('sqlite')
    expect(config.commerce.payments.provider).toBe('native')
    expect(config.security.auth.jwtSecret).toBe(DEFAULT_JWT_SECRET)
    await migrated(config, sqlitePath)

    expect(await attempt(config, sqlitePath)).toBeNull()
  })
})
