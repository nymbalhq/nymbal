import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import fc from 'fast-check'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { createCommandStore } from '../../../src/db/command-store.js'
import { runMigrations } from '../../../src/db/migrate.js'
import { runSeed } from '../../../src/seed/run.js'
import { serveKernel } from '../http.js'
import { createKernel, kernelConfig, MIGRATIONS_ROOT, type Kernel } from '../kernel.js'
import { openRaw } from '../raw.js'
import { login, metadataColumn, primedShopper, rolesColumn, tokenRoles } from '../security.js'

// AC-11 and AC-12 on one dialect. AC-11: migration 0004 backfills `customers.roles` from `metadata.roles`, keeping only
// known roles, falling back to ['customer'], and removes the `roles` key from `metadata`. AC-12: after it, a `roles`
// key written into `metadata` by any path grants nothing; the seeded admin's token carries `admin`, and every token's
// roles equal the column.

const KNOWN = ['admin', 'customer', 'guest']

/** The backfill, written out as a reference: known roles survive, otherwise ['customer']. */
function expectedRoles(value: unknown): string[] {
  const kept = Array.isArray(value) ? value.filter((r) => KNOWN.includes(r as string)) : []
  return kept.length > 0 ? (kept as string[]) : ['customer']
}

const sorted = (roles: string[]): string[] => [...roles].sort()

/** A copy of the migrations folder for `dialect` holding only 0000-0003: the schema before the migration under test. */
function migrationsBefore0004(dialect: Kernel['dialect']): { root: string; drop(): void } {
  const root = mkdtempSync(join(tmpdir(), 'security-migrations-'))
  const from = join(MIGRATIONS_ROOT, dialect)
  const to = join(root, dialect)
  mkdirSync(join(to, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(join(from, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>
  }
  journal.entries = journal.entries.filter((entry) => entry.idx <= 3)
  if (journal.entries.length !== 4) throw new Error(`expected migrations 0000-0003 in ${from}`)
  for (const entry of journal.entries) {
    cpSync(join(from, `${entry.tag}.sql`), join(to, `${entry.tag}.sql`))
  }
  writeFileSync(join(to, 'meta', '_journal.json'), JSON.stringify(journal))
  return { root, drop: () => rmSync(root, { recursive: true, force: true }) }
}

interface LegacyCustomer {
  id: string
  email: string
  metadata: Record<string, unknown>
}

async function insertLegacy(
  dialect: Kernel['dialect'],
  target: string,
  rows: LegacyCustomer[],
): Promise<void> {
  const now = new Date().toISOString()
  if (dialect === 'sqlite') {
    const db = new Database(target)
    try {
      const insert = db.prepare(
        'INSERT INTO customers (id, email, password_hash, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      for (const row of rows) {
        insert.run(row.id, row.email, 'x', JSON.stringify(row.metadata), now, now)
      }
    } finally {
      db.close()
    }
    return
  }
  const pool = new pg.Pool({ connectionString: target, max: 1 })
  try {
    for (const row of rows) {
      await pool.query(
        'INSERT INTO customers (id, email, password_hash, metadata, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, $5)',
        [row.id, row.email, 'x', JSON.stringify(row.metadata), now],
      )
    }
  } finally {
    await pool.end()
  }
}

async function migrate(dialect: Kernel['dialect'], target: string, root: string): Promise<void> {
  const storage = dialect === 'sqlite' ? { sqlitePath: target } : { postgresUrl: target }
  const store = createCommandStore(kernelConfig(dialect), storage)
  try {
    await runMigrations(store, { migrationsRoot: root })
  } finally {
    await store.close()
  }
}

/** `metadata.roles` values beyond the five known roles: arrays of known and unknown roles, and non-arrays. */
const rolesValue = fc.oneof(
  fc.uniqueArray(fc.constantFrom('admin', 'customer', 'guest', 'root', 'staff', ''), {
    maxLength: 4,
  }),
  fc.string({ maxLength: 8 }),
  fc.integer(),
  fc.constant(null),
  fc.dictionary(fc.constantFrom('admin', 'x'), fc.boolean()),
)

export function rolesColumnSuite(
  dialect: Kernel['dialect'],
  /** A fresh, empty database: its target and how to drop it afterwards. */
  fresh: () => Promise<{ target: string; drop(): Promise<void> }>,
): void {
  describe(`customers.roles (${dialect})`, () => {
    it("AC-11: migration 0004 turns metadata.roles ['admin'], ['admin','root'], ['root'], \"admin\" and absent into roles ['admin'], ['admin'], ['customer'], ['customer'], ['customer'], keeps every other metadata key, and leaves no roles key in metadata", async () => {
      const db = await fresh()
      const before = migrationsBefore0004(dialect)
      try {
        await migrate(dialect, db.target, before.root)

        const named: Array<{ roles: unknown; expected: string[] }> = [
          { roles: ['admin'], expected: ['admin'] },
          { roles: ['admin', 'root'], expected: ['admin'] },
          { roles: ['root'], expected: ['customer'] },
          { roles: 'admin', expected: ['customer'] },
          { roles: undefined, expected: ['customer'] },
        ]
        const generated = fc
          .sample(rolesValue, { numRuns: 25, seed: 6 })
          .map((roles) => ({ roles, expected: expectedRoles(roles) }))
        const cases = [...named, ...generated].map((c, i) => ({
          ...c,
          row: {
            id: randomUUID(),
            email: `legacy-${i}@security.test`,
            metadata: {
              source: `case-${i}`,
              ...(c.roles !== undefined && { roles: c.roles }),
            },
          },
        }))
        await insertLegacy(
          dialect,
          db.target,
          cases.map((c) => c.row),
        )

        await migrate(dialect, db.target, MIGRATIONS_ROOT)

        const raw = openRaw(dialect, db.target)
        try {
          for (const c of cases) {
            const label = `metadata.roles = ${JSON.stringify(c.roles)}`
            const roles = await rolesColumn(raw, c.row.id)
            expect(sorted(roles), label).toEqual(sorted(c.expected))
            expect(sorted(roles), label).toEqual(sorted(expectedRoles(c.roles)))
            const { roles: _dropped, ...rest } = c.row.metadata as Record<string, unknown>
            expect(await metadataColumn(raw, c.row.id), label).toEqual(rest)
          }
        } finally {
          await raw.close()
        }
      } finally {
        before.drop()
        await db.drop()
      }
    })

    it("AC-12: a roles key written into metadata by the repository, the importer or an admin note write grants nothing (token roles equal the column, ['customer'], and /api/admin/me answers 403); the seeded admin's token carries admin and /api/admin/me answers 200", async () => {
      const db = await fresh()
      const kernel = await createKernel(
        dialect === 'sqlite'
          ? { dialect, sqlitePath: db.target }
          : { dialect, postgresUrl: db.target },
      )
      const served = await serveKernel(kernel)
      const raw = openRaw(dialect, db.target)
      const k = served.kernel
      const password = 'correct-horse-battery'

      async function addRolesToMetadata(id: string): Promise<void> {
        await k.store.transaction(async (tx) => {
          const row = await k.repos.customer.findById(tx, id)
          await k.repos.customer.update(tx, id, {
            metadata: { ...row!.metadata, roles: ['admin'] },
            updatedAt: new Date(),
          })
        })
      }

      async function adminMe(accessToken: string): Promise<number> {
        const res = await fetch(new URL('/api/admin/me', served.baseUrl), {
          headers: { authorization: `Bearer ${accessToken}` },
        })
        return res.status
      }

      try {
        await runSeed({
          config: k.config,
          commandStore: k.store,
          documentStore: k.documentStore,
          eventBus: k.eventBus,
          logger: k.logger,
          version: '0.0.0',
        })
        const shop = await primedShopper(served.baseUrl)

        const admin = await login(served.baseUrl, shop.jar, {
          email: process.env['NYMBAL_ADMIN_EMAIL'] ?? 'admin@nymbal.local',
          password: process.env['NYMBAL_ADMIN_PASSWORD'] ?? 'nymbal-admin-dev',
        })
        expect(admin.status, JSON.stringify(admin.body)).toBe(200)
        const adminToken = admin.body.data!.accessToken
        expect(tokenRoles(adminToken)).toContain('admin')
        expect(await adminMe(adminToken)).toBe(200)

        // The repository's metadata patch.
        const patchedEmail = `patched-${randomUUID()}@security.test`
        const patched = await k.services.auth.register({ email: patchedEmail, password })
        await addRolesToMetadata(patched.customer.id)

        // The importer: a new row, then given a password so it can log in.
        const importedEmail = `imported-${randomUUID()}@security.test`
        const imported = await k.services.auth.importCustomer({
          email: importedEmail,
          metadata: { roles: ['admin'] },
        })
        const hash = await bcrypt.hash(password, 4)
        await k.store.transaction((tx) =>
          k.repos.customer.update(tx, imported.id, {
            passwordHash: hash,
            requiresPasswordReset: false,
            updatedAt: new Date(),
          }),
        )

        // An admin note write, which rewrites metadata wholesale with the roles key in it.
        const notedEmail = `noted-${randomUUID()}@security.test`
        const noted = await k.services.auth.register({ email: notedEmail, password })
        await addRolesToMetadata(noted.customer.id)
        const note = await shop.call(
          'POST',
          `/api/admin/customers/${noted.customer.id}/notes`,
          { body: 'called about an order' },
          { headers: { authorization: `Bearer ${adminToken}` } },
        )
        expect(note.status, JSON.stringify(note.body)).toBe(200)

        for (const [path, email, id] of [
          ['repository patch', patchedEmail, patched.customer.id],
          ['importCustomer', importedEmail, imported.id],
          ['admin note write', notedEmail, noted.customer.id],
        ] as const) {
          const answer = await login(served.baseUrl, shop.jar, { email, password })
          expect(answer.status, `${path}: ${JSON.stringify(answer.body)}`).toBe(200)
          const roles = tokenRoles(answer.body.data!.accessToken)
          expect(roles, path).toEqual(['customer'])
          expect(roles, path).toEqual(await rolesColumn(raw, id))
          expect(await adminMe(answer.body.data!.accessToken), path).toBe(403)
        }

        // The seeded admin's roles come from the column seed wrote.
        expect(sorted(tokenRoles(adminToken))).toEqual(
          sorted(await rolesColumn(raw, admin.body.data!.customer.id)),
        )
      } finally {
        await raw.close()
        await served.stop()
        await db.drop()
      }
    })
  })
}
