import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'
import { createApp, type NymbalApp } from '../../src/app.js'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createLogger } from '../../src/logger.js'
import { kernelConfig, MIGRATIONS_ROOT } from '../support/kernel.js'

// P1-05 AC-8: a production process refuses the stub payments adapter and the schema's default JWT secret before it
// opens the store; development and test are unchanged. Kills: no check (in production the stub's unsigned webhook
// confirms any order), or a check that runs after createPlatform opened the store file.

const DEFAULT_JWT_SECRET = 'dev-secret-please-override-me-1234567890'
const logger = createLogger({ pretty: false, level: 'error' })

function withStripe(config: NymbalConfig): NymbalConfig {
  return {
    ...config,
    commerce: {
      ...config.commerce,
      payments: {
        provider: 'stripe',
        config: { secretKey: 'sk_test_p1_05_never_called', webhookSecret: 'whsec_p1_05' },
      },
    },
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

  afterEach(async () => {
    if (nodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnv
    for (const app of apps.splice(0)) await app.stop()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function storePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'p1-05-prod-'))
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
  async function attempt(config: NymbalConfig, sqlitePath: string): Promise<unknown> {
    try {
      apps.push(await createApp(config, { sqlitePath, logger }))
      return null
    } catch (error) {
      return error
    }
  }

  it('AC-8: NODE_ENV=production with payments provider native rejects with ConfigError config.production_stub_payments before any store file is created', async () => {
    process.env.NODE_ENV = 'production'
    const sqlitePath = storePath()
    const config = withJwtSecret(kernelConfig('sqlite'), 'p1-05-production-secret-0123456789')
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
      'p1-05-production-secret-0123456789',
    )
    await migrated(config, sqlitePath)

    expect(await attempt(config, sqlitePath)).toBeNull()
    expect(existsSync(sqlitePath)).toBe(true)
  })

  // Decision 7 refuses the resolved stub, so a provider name the registry does not know (its fallback branch) is
  // refused like `native`. Kills a check on the string 'native', and a check that opens the store before refusing.
  it('AC-8: in production every stub-or-default-secret cell is refused with a code the spec predicts and leaves the store directory as it found it', async () => {
    process.env.NODE_ENV = 'production'
    const CUSTOM_SECRET = 'p1-05-production-secret-0123456789'
    const cells = [
      { provider: 'native', secret: CUSTOM_SECRET },
      { provider: 'native', secret: DEFAULT_JWT_SECRET },
      { provider: 'p1-05-unregistered-provider', secret: CUSTOM_SECRET },
      { provider: 'p1-05-unregistered-provider', secret: DEFAULT_JWT_SECRET },
      { provider: 'stripe', secret: DEFAULT_JWT_SECRET },
    ]

    /** The refusal codes decision 7 predicts for a cell; createApp throws one of them. */
    function predictedCodes(cell: { provider: string; secret: string }): string[] {
      const codes: string[] = []
      if (cell.provider !== 'stripe') codes.push('config.production_stub_payments')
      if (cell.secret === DEFAULT_JWT_SECRET) codes.push('config.production_default_jwt_secret')
      return codes
    }

    const results = []
    for (const cell of cells) {
      const sqlitePath = storePath()
      const dir = dirname(sqlitePath)
      const base = kernelConfig('sqlite')
      const config = withJwtSecret(
        cell.provider === 'stripe'
          ? withStripe(base)
          : {
              ...base,
              commerce: { ...base.commerce, payments: { provider: cell.provider } },
            },
        cell.secret,
      )
      const filesBefore = readdirSync(dir).sort()
      const error = await attempt(config, sqlitePath)
      const filesAfter = readdirSync(dir).sort()
      results.push({ cell, error, filesBefore, filesAfter })
    }

    const unpredicted = results
      .filter(({ cell, error }) => {
        if (!(error instanceof ConfigError)) return true
        if (!predictedCodes(cell).includes(error.code)) return true
        // A stub refusal names the configured provider, not a hard-coded 'native'.
        return (
          error.code === 'config.production_stub_payments' && !error.message.includes(cell.provider)
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
