import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { diagnose } from '../../src/index.js'
import { createLogger } from '../../src/logger.js'
import { buildRepositories } from '../../src/repositories/index.js'
import { tagged, VECTORS } from '../../src/services/fixtures/wordpress-vectors.js'
import { kernelConfig, MIGRATIONS_ROOT } from '../support/kernel.js'

// `nymbal doctor` says how many imported WordPress password hashes the store still holds and whether they are honoured:
// none; honoured until a date; held with no date (never honoured); held past the date (the sweep has not run since).
// It reads the store read-only. The clock is faked (Date only) so the days left are exact.

const logger = createLogger({ pretty: false, level: 'silent' })
const NOW = Date.parse('2026-11-19T00:00:00.000Z')
const HELD = 3

let dir = ''
let empty = ''
let holding = ''

async function storeAt(path: string, tags: number): Promise<void> {
  const config = kernelConfig('sqlite')
  const store = createCommandStore(config, { sqlitePath: path })
  try {
    await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
    const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
    const kinds = [
      ...Array.from({ length: tags }, (_, i) => tagged(VECTORS[i]!.hash)),
      'IMPORTED_NO_PASSWORD',
      '$2a$04$abcdefghijklmnopqrstuuJ8m1XbHbpb2wZpWmbzQ0OdD3Pq3HY7e',
    ]
    const at = new Date(NOW - 86_400_000)
    await store.transaction(async (tx) => {
      for (const passwordHash of kinds) {
        await repos.customer.insert(tx, {
          id: randomUUID(),
          email: `${randomUUID().slice(0, 8)}@doctor.test`,
          passwordHash,
          requiresPasswordReset: passwordHash !== kinds.at(-1),
          createdAt: at,
          updatedAt: at,
        })
      }
    })
  } finally {
    await store.close()
  }
}

function customers(path: string): unknown[] {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    return db.prepare('SELECT * FROM customers ORDER BY id').all()
  } finally {
    db.close()
  }
}

function withLegacy(until: string | undefined): NymbalConfig {
  const config = kernelConfig('sqlite')
  if (until === undefined) return config
  return {
    ...config,
    security: {
      ...config.security,
      auth: { ...config.security.auth, legacy: { until, maxCost: 10 } },
    },
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-doctor-legacy-'))
  empty = join(dir, 'empty.sqlite')
  holding = join(dir, 'holding.sqlite')
  await storeAt(empty, 0)
  await storeAt(holding, HELD)
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

const lineOf = async (config: NymbalConfig, sqlitePath: string) =>
  (await diagnose(config, { sqlitePath, logger })).checks.find((c) => c.name === 'legacy passwords')

describe('AC-15: doctor’s legacy passwords line', () => {
  it('AC-15: none held is ok; held with a future date is ok with the count, the date and the days left; held with no date and held past the date are degraded with what to do; the store is unchanged', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const before = customers(holding)

    const lines = [
      await lineOf(withLegacy(undefined), empty),
      await lineOf(withLegacy('2027-01-03'), holding),
      await lineOf(withLegacy(undefined), holding),
      await lineOf(withLegacy('2026-10-01'), holding),
    ]

    expect(lines).toEqual([
      { name: 'legacy passwords', status: 'ok', detail: 'none held' },
      {
        name: 'legacy passwords',
        status: 'ok',
        detail: `${HELD} held; honoured until 2027-01-03 (45 days)`,
      },
      {
        name: 'legacy passwords',
        status: 'degraded',
        detail: `${HELD} held and not honoured: set security.auth.legacy.until, or they stay at rest`,
      },
      {
        name: 'legacy passwords',
        status: 'degraded',
        detail: `${HELD} held past security.auth.legacy.until: (re)start the store; its sweep runs at start and hourly`,
      },
    ])
    expect(customers(holding)).toEqual(before)
    expect(customers(holding)).toHaveLength(HELD + 2)
  })

  it('AC-15: the count follows the store: a date a day nearer reads one day fewer, and the count is the rows that hold a tagged value', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW + 86_400_000)
    const held = (customers(holding) as Array<{ password_hash: string }>).filter((r) =>
      r.password_hash.startsWith('legacy:'),
    ).length
    expect(await lineOf(withLegacy('2027-01-03'), holding)).toEqual({
      name: 'legacy passwords',
      status: 'ok',
      detail: `${held} held; honoured until 2027-01-03 (44 days)`,
    })
  })
})
