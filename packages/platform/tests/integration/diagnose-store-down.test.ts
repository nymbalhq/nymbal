import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { diagnose } from '../../src/index.js'
import { createLogger } from '../../src/logger.js'
import { kernelConfig, MIGRATIONS_ROOT } from '../support/kernel.js'

// The native search and reviews adapters query the command store, so with it down doctor reports them not checked
// rather than ok; the same config on a migrated store reports them healthy.

const logger = createLogger({ pretty: false, level: 'silent' })
const config = kernelConfig('sqlite')
// In the report's slot order.
const OVER_THE_STORE = ['slot reviews', 'slot search']

let dir = ''
let migrated = ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-doctor-store-down-'))
  migrated = join(dir, 'store.sqlite')
  const store = createCommandStore(config, { sqlitePath: migrated })
  try {
    await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
  } finally {
    await store.close()
  }
})

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

describe('doctor with the command store down', () => {
  it('AC-1: native search and reviews are down as not checked when the command store is down, and healthy over a migrated one', async () => {
    const down = await diagnose(config, { sqlitePath: join(dir, 'absent.sqlite'), logger })
    const up = await diagnose(config, { sqlitePath: migrated, logger })
    const pick = (checks: typeof down.checks) =>
      checks.filter((c) => OVER_THE_STORE.includes(c.name))

    expect(down.checks.find((c) => c.name === 'command store')?.status).toBe('down')
    expect(pick(down.checks)).toEqual(
      OVER_THE_STORE.map((name) => ({
        name,
        status: 'down',
        detail: 'not checked: command store down',
      })),
    )
    expect(pick(up.checks).map((c) => [c.name, c.status])).toEqual(
      OVER_THE_STORE.map((name) => [name, 'healthy']),
    )
    expect(down.checks.map((c) => c.name)).toEqual(up.checks.map((c) => c.name))
  })
})
