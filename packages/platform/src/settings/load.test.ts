import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isMissingSettingsTable } from './load.js'

// AC-5: a store from before the settings table boots with no settings on either dialect. drizzle-orm wraps a
// node-postgres error in its own (message `Failed query: <sql>\nparams: <values>`, the driver's error as `cause`), while
// better-sqlite3's errors reach the caller as they are; the check sees the missing relation either way and nothing
// else.

type Dialect = 'postgres' | 'sqlite'

const SETTINGS_SELECT =
  'select "slot", "key", "value", "secret", "updated_at" from "settings" order by "slot", "key"'

/** The driver's own error for `settings` missing. */
function missingRelation(dialect: Dialect): Error {
  return dialect === 'postgres'
    ? Object.assign(new Error('relation "settings" does not exist'), {
        code: '42P01',
        severity: 'ERROR',
      })
    : Object.assign(new Error('no such table: settings'), { code: 'SQLITE_ERROR' })
}

/** A driver error that is not a missing settings table. */
const otherError = fc.oneof(
  fc.constantFrom(
    Object.assign(new Error('duplicate key value violates unique constraint "settings_pkey"'), {
      code: '23505',
    }),
    Object.assign(new Error('column "secret" does not exist'), { code: '42703' }),
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }),
    Object.assign(new Error('no such table: settings_history'), { code: 'SQLITE_ERROR' }),
    Object.assign(new Error('no such column: secret'), { code: 'SQLITE_ERROR' }),
    new Error('settings could not be read'),
  ),
  fc.string().map((message) => new Error(message)),
)

/** What drizzle 0.45 throws for a failed query: the SQL and its parameters in the message, the driver error as cause. */
function wrapped(sql: string, params: unknown[], cause: unknown): Error {
  return new Error(`Failed query: ${sql}\nparams: ${params.join(',')}`, { cause })
}

const params = fc.array(fc.oneof(fc.emailAddress(), fc.integer().map(String)), { maxLength: 3 })

describe('AC-5: a missing settings table is recognised raw or wrapped, on either dialect', () => {
  it('AC-5: true for the missing-relation error of either dialect whether drizzle wraps it or not, false for any other error wrapped or not', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Dialect>('postgres', 'sqlite'),
        fc.boolean(),
        fc.oneof(fc.constant(null), otherError),
        params,
        (dialect, wrap, other, values) => {
          const driverError = other ?? missingRelation(dialect)
          const thrown = wrap ? wrapped(SETTINGS_SELECT, values, driverError) : driverError
          expect(isMissingSettingsTable(thrown)).toBe(other === null)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('AC-5: a Postgres missing relation wrapped as drizzle 0.45 wraps it is recognised, as the raw one is', () => {
    const raw = missingRelation('postgres')
    const viaDrizzle = wrapped(SETTINGS_SELECT, [], raw)

    expect(isMissingSettingsTable(viaDrizzle)).toBe(isMissingSettingsTable(raw))
    expect(isMissingSettingsTable(viaDrizzle)).toBe(true)
  })

  it('AC-5: a value that is not an error is not a missing table', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.constant(undefined), fc.string(), fc.integer()),
        (value) => {
          expect(isMissingSettingsTable(value)).toBe(false)
        },
      ),
    )
  })
})
