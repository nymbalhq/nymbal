import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { AuthError, EVT_CUSTOMER_CREATED, EVT_CUSTOMER_UPDATED } from '@nymbalhq/types'
import { runAsActor } from '../audit/actor.js'
import { createCommandStore, rawClients, type CommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createEventPublisher, createRelay } from '../index.js'
import { createLogger } from '../logger.js'
import { listAuditEntries } from '../repositories/audit-entry.js'
import { buildRepositories, type Repositories } from '../repositories/index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createAuthService, type AuthService } from './auth-service.js'
import { tagged, vector } from './fixtures/wordpress-vectors.js'
import type { OldPlatformCheck, RemoteAnswer, RemoteProfile } from './legacy-remote.js'

// Sign-ins the old platform vouches for, on a SQLite command store per test with real bcrypt: what the row, the events
// and the audit hold afterwards, who is asked, and two first sign-ins that meet. The old platform is a scripted check
// that can hold its answers until every expected sign-in has asked, so the two writes meet without a timer.

const DAY_MS = 24 * 60 * 60_000
const REFUSED = { code: 'auth.invalid_credentials', message: 'Invalid email or password' }
const guest = { kind: 'guest', id: 'guest-1' } as const

/** An old platform answering `answer` to every check, recording each address and password it is sent. */
function scriptedRemote(answer: RemoteAnswer, opts: { holdUntil?: number } = {}) {
  const asked: Array<{ email: string; password: string }> = []
  const waiting: Array<() => void> = []
  const remote: OldPlatformCheck = {
    async check(email, password) {
      asked.push({ email, password })
      if (opts.holdUntil !== undefined) {
        await new Promise<void>((resolve) => {
          waiting.push(resolve)
          if (waiting.length >= opts.holdUntil!) for (const go of waiting.splice(0)) go()
        })
      }
      return answer
    },
    decoyMs: () => 0,
  }
  return { remote, asked }
}

const vouched = (profile: RemoteProfile = {}): RemoteAnswer => ({ status: 'ok', profile })

const open: CommandStore[] = []
afterEach(async () => {
  for (const store of open.splice(0)) await store.close()
})

async function openStore() {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  open.push(store)
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const logger = createLogger({ pretty: false, level: 'silent' })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  const { publisher } = wirePublisher(
    { createEventPublisher, createRelay },
    { store, eventLog: repos.eventLog, eventBus: new InProcessEventBus({ logger }), logger },
  )
  const service = (remote: OldPlatformCheck, over: Repositories = repos): AuthService =>
    createAuthService({
      repos: over,
      publisher,
      logger,
      jwtSecret: 'test-secret-32-characters-long-x',
      accessTtl: '15m',
      refreshTtl: '7d',
      verification: 'required',
      legacy: { until: new Date(Date.now() + 30 * DAY_MS), maxCost: 10, remote },
      sleep: async () => {},
    })
  return { store, repos, service }
}

type Opened = Awaited<ReturnType<typeof openStore>>

function sqlite(o: Opened) {
  const clients = rawClients(o.store)
  if (clients.kind !== 'sqlite') throw new Error('this file runs on SQLite')
  return clients.raw
}

const rowsAt = (o: Opened, email: string) =>
  sqlite(o).prepare('SELECT * FROM customers WHERE email = ?').all(email) as Array<
    Record<string, unknown>
  >

/** The payloads of the events of `type` in the store's log that name `customerId`. */
function eventsFor(o: Opened, type: string, customerId: string): Array<Record<string, unknown>> {
  const rows = sqlite(o).prepare('SELECT envelope FROM events WHERE type = ?').all(type) as Array<{
    envelope: string
  }>
  return rows
    .map((r) => (JSON.parse(r.envelope) as { payload: Record<string, unknown> }).payload)
    .filter((p) => p['customerId'] === customerId)
}

/** The audit's commands that name `customerId`, with the subjects each entry carries. */
async function auditFor(o: Opened, customerId: string) {
  const entries = await o.store.read((tx) => listAuditEntries(tx, { order: 'asc', limit: 500 }))
  return entries
    .filter((e) => e.subjects.some((s) => s.id === customerId))
    .map((e) => ({ command: e.command, subjects: e.subjects }))
}

async function answerOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p
    return { code: 'signed in', message: '' }
  } catch (error) {
    if (error instanceof AuthError) return { code: error.code, message: error.message }
    return { code: 'threw', message: error instanceof Error ? error.message : String(error) }
  }
}

const address = (tag: string) => `${tag}-${randomUUID().slice(0, 8)}@old.test`

describe('AC-6: an address with no customer that the old platform vouches for', () => {
  it('AC-6: becomes one customer at the lowercased address holding the typed password, the answer’s profile and no confirmation asked, announced once as an import and audited as an old-platform sign-in', async () => {
    const o = await openStore()
    const { remote } = scriptedRemote(
      vouched({ firstName: 'Ada', lastName: 'Lovelace', phone: '+441234567' }),
    )
    const auth = o.service(remote)
    const typed = address('New').replace('@old', '@OLD')
    const email = typed.toLowerCase()

    const signedIn = await runAsActor(guest, () => auth.login(typed, 'from-the-old-platform'))

    const rows = rowsAt(o, email)
    expect(rows.map((r) => r['id'])).toEqual([signedIn.customer.id])
    const row = rows[0]!
    expect(signedIn.customer.email).toBe(email)
    expect(await bcrypt.compare('from-the-old-platform', String(row['password_hash']))).toBe(true)
    expect(bcrypt.getRounds(String(row['password_hash']))).toBe(10)
    expect([row['first_name'], row['last_name'], row['phone'], row['email_verification']]).toEqual([
      'Ada',
      'Lovelace',
      '+441234567',
      null,
    ])
    expect(eventsFor(o, EVT_CUSTOMER_CREATED, signedIn.customer.id)).toEqual([
      expect.objectContaining({
        customerId: signedIn.customer.id,
        email,
        origin: 'import',
        customer: expect.objectContaining({ id: signedIn.customer.id, email }),
      }),
    ])
    expect(await auditFor(o, signedIn.customer.id)).toEqual([
      {
        command: 'customer.oldPlatformSignIn',
        subjects: [{ type: 'customer', id: signedIn.customer.id }],
      },
    ])
    // The tokens are a session of this customer: the refresh token refreshes.
    expect((await auth.refresh(signedIn.tokens.refreshToken)).refreshToken).not.toBe(
      signedIn.tokens.refreshToken,
    )
  })
})

describe('AC-7: an imported customer holding the marker that the old platform vouches for', () => {
  it('AC-7: whatever the casing of the address typed, signs in as that customer, the old platform is sent the lowercased address, the row keeps its imported names, and the audit names an old-platform sign-in with the customer as subject', async () => {
    const o = await openStore()
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 30, maxLength: 30 }), async (upper) => {
        const { remote, asked } = scriptedRemote(vouched({ firstName: 'Overwritten' }))
        const auth = o.service(remote)
        const email = address('marker')
        const imported = await auth.importCustomer({ email, firstName: 'Imported' })
        const typed = [...email].map((c, i) => (upper[i] === true ? c.toUpperCase() : c)).join('')

        const signedIn = await runAsActor(guest, () => auth.login(typed, 'vouched-password'))

        expect(signedIn.customer.id).toBe(imported.id)
        expect(asked.map((a) => a.email)).toEqual([email])
        const rows = rowsAt(o, email)
        expect(rows.map((r) => r['id'])).toEqual([imported.id])
        expect(rows[0]!['first_name']).toBe('Imported')
        expect(rows[0]!['requires_password_reset']).toBeFalsy()
        expect(await bcrypt.compare('vouched-password', String(rows[0]!['password_hash']))).toBe(
          true,
        )
        expect(await auditFor(o, imported.id)).toEqual([
          {
            command: 'customer.oldPlatformSignIn',
            subjects: [{ type: 'customer', id: imported.id }],
          },
        ])
        expect(eventsFor(o, EVT_CUSTOMER_UPDATED, imported.id)).toHaveLength(1)
        expect(eventsFor(o, EVT_CUSTOMER_CREATED, imported.id)).toHaveLength(1)
      }),
      { numRuns: 4 },
    )
  })

  it('AC-7: a right WordPress password, with the old platform’s check on, is audited as a hash upgrade with the customer as subject and never as an old-platform sign-in', async () => {
    const o = await openStore()
    const { remote, asked } = scriptedRemote(vouched())
    const auth = o.service(remote)
    const v = vector('phpass ascii')
    const email = address('wp')
    const imported = await auth.importCustomer({ email })
    expect(await auth.importLegacyPassword({ email, recipe: 'wordpress', hash: v.hash })).toBe(
      'stored',
    )

    const signedIn = await runAsActor(guest, () => auth.login(email, v.password))

    expect(signedIn.customer.id).toBe(imported.id)
    expect(asked).toEqual([])
    expect(await auditFor(o, imported.id)).toEqual([
      {
        command: 'customer.upgradePassword',
        subjects: [{ type: 'customer', id: imported.id }],
      },
    ])
  })
})

describe('AC-8: a saved password is never sent to the old platform', () => {
  it('AC-8: a wrong password for a native customer and for a WordPress-hash customer is refused as any wrong password, though the old platform would vouch, and leaves the row as it was', async () => {
    const o = await openStore()
    const { remote, asked } = scriptedRemote(vouched())
    const auth = o.service(remote)
    const native = address('native')
    const nativeRow = await auth.importCustomer({ email: native })
    sqlite(o)
      .prepare('UPDATE customers SET password_hash = ?, requires_password_reset = 0 WHERE id = ?')
      .run(await bcrypt.hash('the-right-one', 10), nativeRow.id)
    const wp = address('wp')
    await auth.importCustomer({ email: wp })
    await auth.importLegacyPassword({
      email: wp,
      recipe: 'wordpress',
      hash: vector('phpass ascii').hash,
    })

    for (const email of [native, wp]) {
      const before = rowsAt(o, email)
      expect(await answerOf(auth.login(email, 'not-their-password'))).toEqual(REFUSED)
      expect(rowsAt(o, email)).toEqual(before)
    }
    expect(rowsAt(o, wp)[0]!['password_hash']).toBe(tagged(vector('phpass ascii').hash))
    expect(asked).toEqual([])
  })
})

describe('AC-12: two first sign-ins at once', () => {
  it('AC-12: for an unknown address with the same password, make one customer and one customer.created, and both sign in as it with sessions that refresh', async () => {
    const o = await openStore()
    const { remote, asked } = scriptedRemote(vouched(), { holdUntil: 2 })
    const auth = o.service(remote)
    const email = address('race')

    const both = await Promise.all([
      auth.login(email, 'same-password'),
      auth.login(email, 'same-password'),
    ])

    expect(asked).toHaveLength(2)
    const ids = rowsAt(o, email).map((r) => r['id'])
    expect(ids).toHaveLength(1)
    expect(both.map((b) => b.customer.id)).toEqual([ids[0], ids[0]])
    expect(eventsFor(o, EVT_CUSTOMER_CREATED, String(ids[0]))).toHaveLength(1)
    for (const b of both) {
      expect((await auth.refresh(b.tokens.refreshToken)).refreshToken).not.toBe(
        b.tokens.refreshToken,
      )
    }
  })

  it('AC-12: for a marker customer with the same password, one write takes: one customer.updated, both sign in as that customer with sessions that refresh', async () => {
    const o = await openStore()
    const { remote, asked } = scriptedRemote(vouched(), { holdUntil: 2 })
    const auth = o.service(remote)
    const email = address('marker-race')
    const imported = await auth.importCustomer({ email })

    const both = await Promise.all([
      auth.login(email, 'same-password'),
      auth.login(email, 'same-password'),
    ])

    expect(asked).toHaveLength(2)
    expect(both.map((b) => b.customer.id)).toEqual([imported.id, imported.id])
    expect(eventsFor(o, EVT_CUSTOMER_UPDATED, imported.id)).toHaveLength(1)
    for (const b of both) {
      expect((await auth.refresh(b.tokens.refreshToken)).refreshToken).not.toBe(
        b.tokens.refreshToken,
      )
    }
  })

  it('AC-12: when the two typed different passwords, the row holds one of them and only the sign-in that typed it succeeds; the other is refused as a wrong password', async () => {
    for (const marker of [false, true]) {
      const o = await openStore()
      const { remote } = scriptedRemote(vouched(), { holdUntil: 2 })
      const auth = o.service(remote)
      const email = address(marker ? 'marker-split' : 'split')
      if (marker) await auth.importCustomer({ email })

      const answers = await Promise.all([
        answerOf(auth.login(email, 'password-one')),
        answerOf(auth.login(email, 'password-two')),
      ])

      const rows = rowsAt(o, email)
      expect(rows).toHaveLength(1)
      const hash = String(rows[0]!['password_hash'])
      const holds = [
        await bcrypt.compare('password-one', hash),
        await bcrypt.compare('password-two', hash),
      ]
      expect(answers, `marker: ${marker}`).toEqual(
        holds.map((h) => (h ? { code: 'signed in', message: '' } : REFUSED)),
      )
      expect(holds.filter(Boolean)).toHaveLength(1)
    }
  })

  it('AC-12: when the other sign-in’s row commits between this one’s read and its insert (as on Postgres), the insert’s unique failure is answered by a sign-in against that row', async () => {
    const o = await openStore()
    const email = address('late')
    const first = await o.service(scriptedRemote(vouched()).remote).login(email, 'same-password')
    // This sign-in reads the address as it stood before the first committed, until its own insert meets the row.
    let stale = true
    const behind: Repositories = {
      ...o.repos,
      customer: {
        ...o.repos.customer,
        findByEmail: (tx, e) =>
          stale && e === email ? Promise.resolve(null) : o.repos.customer.findByEmail(tx, e),
        insert: (tx, c) => {
          stale = false
          return o.repos.customer.insert(tx, c)
        },
      },
    }
    const { remote, asked } = scriptedRemote(vouched())

    const second = await o.service(remote, behind).login(email, 'same-password')

    expect(asked).toHaveLength(1)
    expect(stale).toBe(false)
    expect(second.customer.id).toBe(first.customer.id)
    expect(rowsAt(o, email)).toHaveLength(1)
    expect(eventsFor(o, EVT_CUSTOMER_CREATED, first.customer.id)).toHaveLength(1)
  })

  it('AC-12: an insert that fails with no row at the address is that failure, not a wrong password, and leaves no customer', async () => {
    const o = await openStore()
    const email = address('broken')
    const failing: Repositories = {
      ...o.repos,
      customer: {
        ...o.repos.customer,
        insert: () => Promise.reject(new Error('the disk is full')),
      },
    }

    const answer = await answerOf(
      o.service(scriptedRemote(vouched()).remote, failing).login(email, 'vouched-password'),
    )

    expect(answer).toEqual({ code: 'threw', message: 'the disk is full' })
    expect(rowsAt(o, email)).toEqual([])
  })
})

