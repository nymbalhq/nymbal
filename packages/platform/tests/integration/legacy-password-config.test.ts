import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { vector } from '../../src/services/fixtures/wordpress-vectors.js'
import { createKernel } from '../support/kernel.js'
import {
  customerRowOf,
  login,
  openPasswordStore,
  type PasswordStore,
} from '../support/password-reset.js'

// `security.auth.legacy` in a store's config reaches the sign-in and the sweep: an app booted from config with a
// future date signs a WordPress customer in over HTTP and upgrades the row, at the cost the config opted into; one
// booted with a past date refuses that sign-in and its own sweep leaves the no-password marker. The date is read in
// UTC whatever the process's time zone.

const DAY_MS = 24 * 60 * 60_000
const IMPORTED_NO_PASSWORD = 'IMPORTED_NO_PASSWORD'
const dateIn = (days: number): string =>
  new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10)

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A store booted from config whose `security.auth.legacy` is `legacy`, parsed as loadConfig parses a store's file. */
function bootWith(legacy: Record<string, unknown>, sqlitePath?: string): Promise<PasswordStore> {
  return openPasswordStore((opts) =>
    createKernel({
      dialect: 'sqlite',
      ...(sqlitePath !== undefined && { sqlitePath }),
      ...opts,
      configure: (config) => {
        const base = opts.configure(config)
        return nymbalConfigSchema.parse({
          ...base,
          security: { ...base.security, auth: { ...base.security.auth, legacy } },
        }) as NymbalConfig
      },
      appOptions: { ...opts.appOptions, legacyPasswordSweep: { intervalMs: 50 } },
    }),
  )
}

async function legacyCustomer(
  s: PasswordStore,
  hash: string,
): Promise<{ id: string; email: string }> {
  const email = `config-${randomUUID().slice(0, 8)}@legacy.test`
  const { id } = await s.k.services.auth.importCustomer({ email })
  expect(await s.k.services.auth.importLegacyPassword({ email, recipe: 'wordpress', hash })).toBe(
    'stored',
  )
  return { id, email }
}

describe('AC-17: the config reaches the store', () => {
  it('AC-17: booted with a future until, a WordPress customer signs in over POST /api/auth/login and the row becomes a native hash', async () => {
    const s = await bootWith({ until: dateIn(30) })
    try {
      const v = vector('phpass ascii')
      const c = await legacyCustomer(s, v.hash)
      const answer = await login(s, c.email, v.password)
      const row = await customerRowOf(s, c.id)
      expect([answer.status, answer.body.data?.customer?.id]).toEqual([200, c.id])
      expect([
        bcrypt.getRounds(row.password_hash),
        await bcrypt.compare(v.password, row.password_hash),
      ]).toEqual([10, true])
    } finally {
      await s.close()
    }
  })

  it('AC-17: booted with maxCost 12, a $wp$2y$12$ customer is stored, signs in over HTTP and is upgraded', async () => {
    const s = await bootWith({ until: dateIn(30), maxCost: 12 })
    try {
      const v = vector('wp bcrypt 12 ascii')
      const c = await legacyCustomer(s, v.hash)
      const answer = await login(s, c.email, v.password)
      const row = await customerRowOf(s, c.id)
      expect([
        answer.status,
        bcrypt.getRounds(row.password_hash),
        row.password_hash.startsWith('legacy:'),
      ]).toEqual([200, 10, false])
    } finally {
      await s.close()
    }
  }, 30_000)

  it('AC-17: a fresh app booted with a past until refuses the right WordPress password with 401 and the generic message, and its own sweep leaves IMPORTED_NO_PASSWORD in every tagged row within 2 s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-config-'))
    dirs.push(dir)
    const path = join(dir, 'store.sqlite')
    const v = vector('wp bcrypt 10 ascii')
    const before = await bootWith({ until: dateIn(30) }, path)
    let tagged: Array<{ id: string; email: string }> = []
    try {
      tagged = [
        await legacyCustomer(before, v.hash),
        await legacyCustomer(before, vector('phpass ascii').hash),
      ]
    } finally {
      await before.close()
    }

    const after = await bootWith({ until: '2026-01-01' }, path)
    try {
      const answer = await login(after, tagged[0]!.email, v.password)
      expect([answer.status, answer.body.error?.message]).toEqual([
        401,
        'Invalid email or password',
      ])
      await vi.waitFor(
        async () => {
          const hashes = await Promise.all(
            tagged.map(async (c) => (await customerRowOf(after, c.id)).password_hash),
          )
          expect(hashes).toEqual(tagged.map(() => IMPORTED_NO_PASSWORD))
        },
        { timeout: 2_000, interval: 50 },
      )
    } finally {
      await after.close()
    }
  }, 30_000)

  it('AC-17: under TZ=Pacific/Kiritimati, legacyUntilOf reads 2026-12-01 as midnight UTC, though local midnight that day is 14 hours earlier', async () => {
    const { legacyUntilOf } = await import('../../src/services/legacy-passwords.js')
    const zone = process.env['TZ']
    process.env['TZ'] = 'Pacific/Kiritimati'
    try {
      expect([
        new Date('2026-12-01T00:00:00').toISOString(),
        legacyUntilOf('2026-12-01').toISOString(),
      ]).toEqual(['2026-11-30T10:00:00.000Z', '2026-12-01T00:00:00.000Z'])
    } finally {
      if (zone === undefined) delete process.env['TZ']
      else process.env['TZ'] = zone
    }
  })
})
