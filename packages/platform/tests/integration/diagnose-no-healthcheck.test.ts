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

// Acceptance test for P2-09 AC-5 (f) (spec P2-09-dev-stage, decision 4; Fable recheck M1), in-process: no primitive
// can be injected from a config, so the missing-method case is a `custom` commerce slot. diagnose(config, { adapters:
// { search: <the custom-providers fixture search with healthCheck removed> } }) reports `slot search` degraded with
// `no healthCheck`, and nothing down; its check names are those of the same config with the healthCheck kept.
// Kills: a missing healthCheck that crashes diagnose or reads as down, and a check dropped from the list.

const logger = createLogger({ pretty: false, level: 'silent' })

let dir = ''

/** The kernel config with search `custom`, every other slot native, on a migrated SQLite file. */
const config: NymbalConfig = {
  ...kernelConfig('sqlite'),
  commerce: { ...kernelConfig('sqlite').commerce, search: { provider: 'custom' } },
} as NymbalConfig

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-p2-09-diagnose-'))
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

describe('P2-09 AC-5 (f): a custom slot adapter with no healthCheck', () => {
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
})
