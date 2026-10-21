import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { decrypt, keyId } from '../../../platform/src/settings/crypto.js'
import {
  cleanups,
  keyBytes,
  leaks,
  newSecretsKey,
  saveSettings,
  secretArb,
  SECRETS_KEY,
  SECRETS_KEY_OLD,
  setEnv,
  settingsConfig,
  settingsConfigInput,
  storedSettings,
  tamperCiphertext,
  type StoredSetting,
  openReader,
} from '../../../platform/tests/support/settings.js'
import { cliEnv, runCli } from '../../../../tests/support/doctor.js'

// P3-07 AC-7 (spec P3-07-secrets-settings, Decision 9): `nymbal secrets rotate`, spawned from the built CLI
// (`pnpm build` first) in a project whose settings rows were saved through the admin API under OLD. Property over n
// rows (a generated subset of the declared secrets of a Stripe and Anthropic store, with or without plain rows): with
// NYMBAL_SECRETS_KEY_OLD=OLD and NYMBAL_SECRETS_KEY=NEW it exits 0, every secret row decrypts under NEW to the value
// saved and carries NEW's key_id (and no longer decrypts under OLD), plain rows are untouched, no row is lost or added,
// and the output carries no value. With one row that fails under OLD it exits 2 and no row changes.
// Kills: a partial rotation; rows left under the old key.

const COMMERCE = { payments: { provider: 'stripe' }, ai: { provider: 'anthropic' } }
const SECRET_FIELDS = [
  ['payments', 'secretKey'],
  ['payments', 'webhookSecret'],
  ['ai', 'apiKey'],
] as const
const PLAIN_FIELDS = [
  ['payments', 'publishableKey', 'pk_test_p3_07_rotate'],
  ['ai', 'baseUrl', 'http://127.0.0.1:9'],
] as const

const aad = (slot: string, path: string): string => `${slot}:${path}`

/** A project whose nymbal.config.ts is the store's config, on a SQLite file of its own. */
function project(run: ReturnType<typeof cleanups>): { dir: string; db: string } {
  const dir = mkdtempSync(join(tmpdir(), 'p3-07-rotate-'))
  run.add(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify(settingsConfigInput('sqlite', COMMERCE), null, 2)}\n`,
  )
  return { dir, db: join(dir, 'nymbal.db') }
}

const rotate = (dir: string, db: string, oldKey: string, newKey: string) =>
  runCli(['secrets', 'rotate'], {
    cwd: dir,
    env: cliEnv({
      NYMBAL_SQLITE_PATH: db,
      [SECRETS_KEY_OLD]: oldKey,
      [SECRETS_KEY]: newKey,
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
      STRIPE_PUBLISHABLE_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
    }),
  })

describe('P3-07 AC-7: rotation is all or nothing', () => {
  it('AC-7: over n rows, rotate with OLD and NEW set exits 0 and leaves every secret row under NEW with its value, plain rows untouched', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray([...SECRET_FIELDS], { minLength: 1 }),
        fc.subarray([...PLAIN_FIELDS]),
        fc.array(secretArb, { minLength: SECRET_FIELDS.length, maxLength: SECRET_FIELDS.length }),
        async (secrets, plains, values) => {
          const run = cleanups()
          try {
            const oldKey = newSecretsKey()
            const newKey = newSecretsKey()
            run.add(
              setEnv({
                [SECRETS_KEY]: oldKey,
                STRIPE_SECRET_KEY: undefined,
                ANTHROPIC_API_KEY: undefined,
              }),
            )
            const { dir, db } = project(run)
            const secretRows = secrets.map(([slot, path], i) => [slot, path, values[i]!] as const)
            const saved: Array<readonly [string, string, string]> = [...secretRows, ...plains]
            await saveSettings(
              { dialect: 'sqlite', target: db, config: settingsConfig('sqlite', COMMERCE) },
              saved,
            )

            const result = await rotate(dir, db, oldKey, newKey)
            expect(result.code, result.out).toBe(0)
            for (const value of values) expect(leaks([result.out], value)).toEqual([])

            const raw = openReader('sqlite', db)
            run.add(() => raw.close())
            const rows = await storedSettings(raw)
            expect(rows.length).toBe(saved.length)
            const rowOf = (slot: string, path: string) =>
              rows.find((r) => r.slot === slot && r.path === path) as
                | (StoredSetting & Parameters<typeof decrypt>[2])
                | undefined
            for (const [slot, path, value] of secretRows) {
              const row = rowOf(slot, path)
              expect(row, `${slot}.${path}`).toBeDefined()
              expect(row!.key_id).toBe(keyId(keyBytes(newKey)))
              expect(row!.key_id).not.toBe(keyId(keyBytes(oldKey)))
              expect(decrypt(keyBytes(newKey), aad(slot, path), row!)).toBe(value)
              expect(() => decrypt(keyBytes(oldKey), aad(slot, path), row!)).toThrow()
            }
            for (const [slot, path, value] of plains) {
              const row = rowOf(slot, path)
              expect(row?.plain, `${slot}.${path}`).toBe(value)
              expect(row?.ciphertext ?? null).toBeNull()
            }
          } finally {
            await run.run()
          }
        },
      ),
      { numRuns: 4 },
    )
  }, 180_000)

  it('AC-7: with one row that fails under OLD, rotate exits 2 and no row changes', async () => {
    const run = cleanups()
    try {
      const oldKey = newSecretsKey()
      run.add(
        setEnv({
          [SECRETS_KEY]: oldKey,
          STRIPE_SECRET_KEY: undefined,
          ANTHROPIC_API_KEY: undefined,
        }),
      )
      const { dir, db } = project(run)
      await saveSettings(
        { dialect: 'sqlite', target: db, config: settingsConfig('sqlite', COMMERCE) },
        SECRET_FIELDS.map(
          ([slot, path], i) => [slot, path, `p3-07-rotate-${i}-${Date.now()}`] as const,
        ),
      )
      const raw = openReader('sqlite', db)
      run.add(() => raw.close())
      await tamperCiphertext('sqlite', raw, db, 'payments', 'webhookSecret')
      const before = await storedSettings(raw)

      const result = await rotate(dir, db, oldKey, newSecretsKey())
      expect(result.code, result.out).toBe(2)
      expect(before).toEqual(await storedSettings(raw))
      expect(before.length).toBe(SECRET_FIELDS.length)
    } finally {
      await run.run()
    }
  }, 120_000)
})
