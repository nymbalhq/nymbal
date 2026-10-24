import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { createFixtureSearchAdapter } from '../../../../tests/e2e/fixtures/custom-providers/adapters.js'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { diagnose } from '../../src/index.js'
import { createLogger } from '../../src/logger.js'
import { kernelConfig, MIGRATIONS_ROOT } from '../support/kernel.js'

// AC-5 (f), in-process: no primitive can be injected from a config, so the missing-method case is a `custom` search
// slot without healthCheck, reported `slot search` degraded with `no healthCheck` and nothing down. A healthCheck that
// throws synchronously is down with its message, and one that returns a plain report is read as that report; neither
// rejects diagnose.

const logger = createLogger({ pretty: false, level: 'silent' })

let dir = ''

/** The kernel config with search `custom`, every other slot native, on a migrated SQLite file. */
const config: NymbalConfig = {
  ...kernelConfig('sqlite'),
  commerce: { ...kernelConfig('sqlite').commerce, search: { provider: 'custom' } },
} as NymbalConfig

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-doctor-diagnose-'))
  const sqlitePath = join(dir, 'store.sqlite')
  const store = createCommandStore(config, { sqlitePath })
  try {
    await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
  } finally {
    await store.close()
  }
  vi.stubEnv('NYMBAL_SQLITE_PATH', sqlitePath)
})

afterAll(() => {
  vi.unstubAllEnvs()
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

/** The fixture's search adapter as a third party might ship it: everything but healthCheck. */
function searchWithoutHealthCheck() {
  const { healthCheck: _dropped, ...rest } = createFixtureSearchAdapter()
  return rest
}

describe('AC-5 (f): a custom slot adapter with no healthCheck', () => {
  it('AC-5 (f): `slot search` is degraded with `no healthCheck`, nothing is down, and the check names equal those with the healthCheck kept', async () => {
    const kept = await diagnose(config, {
      adapters: { search: createFixtureSearchAdapter() as never },
      logger,
    })
    const missing = await diagnose(config, {
      adapters: { search: searchWithoutHealthCheck() as never },
      logger,
    })
    const search = missing.checks.find((c) => c.name === 'slot search')

    expect(search?.status).toBe('degraded')
    expect(search?.detail).toMatch(/no healthCheck/)
    expect(missing.checks.filter((c) => c.status === 'down')).toEqual([])
    expect(missing.checks.map((c) => c.name)).toEqual(kept.checks.map((c) => c.name))
  })

  it('AC-5 (f): a healthCheck that throws synchronously is `slot search` down with its message, and every other check is still listed', async () => {
    const kept = await diagnose(config, {
      adapters: { search: createFixtureSearchAdapter() as never },
      logger,
    })
    const throwing = {
      ...createFixtureSearchAdapter(),
      healthCheck: (): never => {
        throw new Error('sync boom')
      },
    }
    const run = diagnose(config, { adapters: { search: throwing as never }, logger })

    await expect(run).resolves.toBeDefined()
    const report = await run
    const search = report.checks.find((c) => c.name === 'slot search')
    expect(search?.status).toBe('down')
    expect(search?.detail).toMatch(/sync boom/)
    expect(report.checks.map((c) => c.name)).toEqual(kept.checks.map((c) => c.name))
    expect(report.checks.filter((c) => c.status === 'down').map((c) => c.name)).toEqual([
      'slot search',
    ])
  })

  it('AC-5 (f): a healthCheck that returns a plain `{ status: healthy }`, not a promise, is `slot search` healthy as with the async one', async () => {
    const kept = await diagnose(config, {
      adapters: { search: createFixtureSearchAdapter() as never },
      logger,
    })
    const plain = {
      ...createFixtureSearchAdapter(),
      healthCheck: () => ({ status: 'healthy' as const }),
    }
    const run = diagnose(config, { adapters: { search: plain as never }, logger })

    await expect(run).resolves.toBeDefined()
    const search = (await run).checks.find((c) => c.name === 'slot search')
    expect(search?.status).toBe('healthy')
    expect(search).toEqual(kept.checks.find((c) => c.name === 'slot search'))
  })
})
