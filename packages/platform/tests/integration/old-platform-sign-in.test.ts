import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runAsActor } from '../../src/audit/actor.js'
import type { OldPlatformCheck, RemoteAnswer } from '../../src/services/legacy-remote.js'
import { vector } from '../../src/services/fixtures/wordpress-vectors.js'
import { createKernel } from '../support/kernel.js'
import {
  bodyOf,
  startOldPlatform,
  VALID_FALSE,
  validTrue,
  type FakeOldPlatform,
} from '../../src/tests/old-platform.js'
import { maxSeq } from '../support/outbox.js'
import { truthy, type PasswordStore } from '../support/password-reset.js'
import {
  checkAgainst,
  customersAt,
  entriesFor,
  eventsAbout,
  guest,
  importer,
  markerCustomer,
  oldPlatformAuth,
  oldPlatformSignInSuite,
  openOldPlatformStore,
  refusalOf,
  REFUSED,
  tag,
} from '../support/suites/old-platform-sign-in.js'

// A shopper the store has no password for signs in through the old platform on SQLite: created or completed once,
// signed in ordinarily afterwards; never asked for anyone who has a password here or for input `register` refuses;
// every refusal one answer that writes nothing.

interface CustomerColumns {
  id: string
  email: string
  password_hash: string
  requires_password_reset: unknown
  email_verification: string | null
  first_name: string
  last_name: string
  phone: string
}

/** A sign-in that must succeed: a refusal fails the test on its answer, not on an uncaught error. */
async function signsIn(auth: ReturnType<typeof oldPlatformAuth>, email: string, password: string) {
  let refusal = 'signed in'
  const result = await runAsActor(guest, () => auth.login(email, password)).catch(
    (error: unknown) => {
      refusal = String((error as Error).message)
      return null
    },
  )
  expect(refusal).toBe('signed in')
  return result!
}

const columnsOf = (s: PasswordStore, email: string): Promise<CustomerColumns[]> =>
  s.raw.rows<CustomerColumns>(
    'SELECT id, email, password_hash, requires_password_reset, email_verification, first_name, last_name, phone FROM customers WHERE email = ?',
    [email],
  )

describe('signing in through the old platform (sqlite)', () => {
  let s: PasswordStore
  let fake: FakeOldPlatform

  beforeAll(async () => {
    s = await openOldPlatformStore((opts) => createKernel({ dialect: 'sqlite', ...opts }))
    fake = await startOldPlatform()
  }, 60_000)

  afterAll(async () => {
    await fake?.close()
    await s?.close()
  })

  beforeEach(() => {
    fake.requests.splice(0)
    fake.reply = () => VALID_FALSE
  })

  it('AC-6: an unknown address the old platform vouches for gets one customer at the lowercased address with a cost-10 hash of the typed password, no reset flag, no emailVerification, the answer’s names and phone, one customer.created from the import and a customer.oldPlatformSignIn entry; the next sign-in does not ask again', async () => {
    const auth = oldPlatformAuth(s, checkAgainst(s, fake))
    const typed = `Old.Shopper-${tag()}@Old.Example`
    const email = typed.toLowerCase()
    const password = 'Old platform password 1'
    fake.reply = () =>
      validTrue({ firstName: 'Ada', lastName: 'Lovelace', phone: '+44 20 7946 0000' })

    const first = await signsIn(auth, typed, password)
    const rows = await columnsOf(s, email)
    const row = rows[0]!
    const asRead = await s.k.store.read((tx) => s.k.repos.customer.findById(tx, row.id))
    const subject = (await auth.verifyAccessToken(first.tokens.accessToken)).sub
    const created = await eventsAbout(s, 'customer.created.v1', row.id)
    const askedAfterFirst = fake.requests.length
    const second = await signsIn(auth, email, password)

    expect(rows).toHaveLength(1)
    expect({
      answered: [first.customer.id, first.customer.email, subject],
      rounds: bcrypt.getRounds(row.password_hash),
      verifies: await bcrypt.compare(password, row.password_hash),
      reset: truthy(row.requires_password_reset),
      column: row.email_verification,
      asRead: asRead !== null && 'emailVerification' in asRead,
      names: [row.first_name, row.last_name, row.phone],
    }).toEqual({
      answered: [row.id, email, row.id],
      rounds: 10,
      verifies: true,
      reset: false,
      column: null,
      asRead: false,
      names: ['Ada', 'Lovelace', '+44 20 7946 0000'],
    })
    expect(
      created.map((e) => {
        const p = e.envelope.payload as {
          origin?: string
          email?: string
          customer?: { firstName?: string; email?: string }
        }
        return [p.origin, p.email, p.customer?.email, p.customer?.firstName]
      }),
    ).toEqual([['import', email, email, 'Ada']])
    expect(await entriesFor(s, 'customer.oldPlatformSignIn', row.id)).toHaveLength(1)
    expect([second.customer.id, fake.requests.length]).toEqual([row.id, askedAfterFirst])
    expect(askedAfterFirst).toBe(1)
  })

  it('AC-7: a marker customer the old platform vouches for keeps its imported details: the hash is replaced, the reset flag clears, one customer.updated and no customer.created, customer.oldPlatformSignIn and not customer.upgradePassword', async () => {
    const auth = oldPlatformAuth(s, checkAgainst(s, fake))
    const c = await markerCustomer(s, { firstName: 'Imported', lastName: 'Name', phone: '+44 1' })
    const before = (await columnsOf(s, c.email))[0]!
    const createdBefore = (await eventsAbout(s, 'customer.created.v1', c.id)).length
    const password = 'Old platform password 2'
    fake.reply = () => validTrue({ firstName: 'Overwritten', lastName: 'Other', phone: '+1 999' })

    const signedIn = await signsIn(auth, c.email, password)
    const after = await columnsOf(s, c.email)
    const row = after[0]!

    expect([before.password_hash, truthy(before.requires_password_reset)]).toEqual([
      'IMPORTED_NO_PASSWORD',
      true,
    ])
    expect({
      id: signedIn.customer.id,
      rows: after.length,
      rounds: bcrypt.getRounds(row.password_hash),
      verifies: await bcrypt.compare(password, row.password_hash),
      reset: truthy(row.requires_password_reset),
      details: [row.first_name, row.last_name, row.phone],
    }).toEqual({
      id: c.id,
      rows: 1,
      rounds: 10,
      verifies: true,
      reset: false,
      details: [before.first_name, before.last_name, before.phone],
    })
    expect([
      (await eventsAbout(s, 'customer.updated.v1', c.id)).length,
      (await eventsAbout(s, 'customer.created.v1', c.id)).length - createdBefore,
      (await entriesFor(s, 'customer.oldPlatformSignIn', c.id)).length,
      (await entriesFor(s, 'customer.upgradePassword', c.id)).length,
    ]).toEqual([1, 0, 1, 0])
  })

  it('AC-8: a wrong password for a native, a legacy:wordpress: and a pending customer, input register refuses or that is too long, and anything after the sunset are refused without asking the old platform', async () => {
    const auth = oldPlatformAuth(s, checkAgainst(s, fake))
    const native = `native-${tag()}@old.test`
    await runAsActor(guest, () =>
      s.k.services.auth.register({ email: native, password: 'native-correct-horse' }),
    )
    const wp = `wp-${tag()}@old.test`
    await runAsActor(importer, async () => {
      await s.k.services.auth.importCustomer({ email: wp })
      await s.k.services.auth.importLegacyPassword({
        email: wp,
        recipe: 'wordpress',
        hash: vector('phpass ascii').hash,
      })
    })
    const pending = `pending-${tag()}@old.test`
    await runAsActor(guest, () =>
      s.k.services.auth.signUp({ email: pending, password: 'pending-correct-horse' }),
    )
    const marker = await markerCustomer(s)
    const long = `a@${'x'.repeat(255 - 2 - 5)}.test`.toUpperCase()
    const password257 = `${'é'.repeat(128)}x`
    const never: Array<[string, string, string]> = [
      ['native, wrong password', native, 'wrong-password'],
      ['legacy:wordpress:, wrong password', wp, 'wrong-password'],
      ['pending under required, wrong password', pending, 'wrong-password'],
      ['no @', 'nobody.x.test', 'a-password'],
      ['a space before', ' a@x.test', 'a-password'],
      ['a space after', 'a@x.test ', 'a-password'],
      ['255 bytes once lowercased', long, 'a-password'],
      ['a 257-byte password', 'a@x.test', password257],
    ]
    const got: Array<[string, string]> = []
    for (const [label, email, password] of never) {
      got.push([label, await refusalOf(runAsActor(guest, () => auth.login(email, password)))])
    }
    const sunset = oldPlatformAuth(s, checkAgainst(s, fake), new Date(Date.now() - 1))
    for (const [label, email] of [
      ['after the sunset, unknown', `late-${tag()}@old.test`],
      ['after the sunset, marker', marker.email],
    ] as const) {
      got.push([label, await refusalOf(runAsActor(guest, () => sunset.login(email, 'a-password')))])
    }
    const askedForNone = fake.requests.length
    // The same service asks for an address it may ask about, so a check never wired would not pass for one that asks nobody.
    const control = `control-${tag()}@old.test`
    await refusalOf(runAsActor(guest, () => auth.login(control, 'a-password')))

    expect(got).toEqual(
      [
        ...never.map(([label]) => label),
        'after the sunset, unknown',
        'after the sunset, marker',
      ].map((l) => [l, REFUSED]),
    )
    expect([
      askedForNone,
      fake.requests.map((r) => (bodyOf(r) as { email: string }).email),
    ]).toEqual([0, [control]])
    expect([
      await customersAt(s, 'nobody.x.test'),
      await customersAt(s, ' a@x.test'),
      await customersAt(s, 'a@x.test '),
      await customersAt(s, 'a@x.test'),
    ]).toEqual([0, 0, 0, 0])
    expect(Buffer.byteLength(long.toLowerCase())).toBe(255)
  })

  describe('AC-9: one answer, nothing written', () => {
    const answers: RemoteAnswer[] = [
      { status: 'bad' },
      { status: 'unavailable' },
      { status: 'skipped', why: 'input' },
      { status: 'skipped', why: 'cap' },
      { status: 'skipped', why: 'breaker' },
    ]

    it('AC-9: for each of bad, unavailable and skipped (input, cap, breaker), an unknown address and a marker customer are refused exactly as a native wrong password is, with no customer row, event or audit entry written', async () => {
      const state = { answer: answers[0]!, asked: [] as string[] }
      const remote: OldPlatformCheck = {
        check: async (email: string) => {
          state.asked.push(email)
          return state.answer
        },
        decoyMs: () => 0,
      }
      const auth = oldPlatformAuth(s, remote)
      const native = `native-${tag()}@old.test`
      await runAsActor(guest, () =>
        s.k.services.auth.register({ email: native, password: 'native-correct-horse' }),
      )
      const nativeRefusal = await runAsActor(guest, () =>
        auth.login(native, 'wrong-password'),
      ).then(
        () => null,
        (e: unknown) => e as Error & { code?: string },
      )
      const marker = await markerCustomer(s)
      const markerRow = () =>
        s.raw.one<Record<string, unknown>>('SELECT * FROM customers WHERE id = ?', [marker.id])
      const markerBefore = await markerRow()

      const got: unknown[] = []
      const want: unknown[] = []
      for (const answer of answers) {
        state.answer = answer
        for (const who of ['unknown', 'marker'] as const) {
          const email = who === 'unknown' ? `unknown-${tag()}@old.test` : marker.email
          const seq = await maxSeq(s.raw)
          const audit = await s.raw.count('audit_entries')
          const customers = await s.raw.count('customers')
          const askedBefore = state.asked.length
          const error = await runAsActor(guest, () =>
            auth.login(email, 'old-or-wrong-password'),
          ).then(
            () => null,
            (e: unknown) => e as Error & { code?: string },
          )
          got.push([
            answer,
            who,
            error?.constructor,
            error?.code,
            error?.message,
            (await maxSeq(s.raw)) - seq,
            (await s.raw.count('audit_entries')) - audit,
            (await s.raw.count('customers')) - customers,
            state.asked.slice(askedBefore),
          ])
          want.push([
            answer,
            who,
            nativeRefusal?.constructor,
            nativeRefusal?.code,
            nativeRefusal?.message,
            0,
            0,
            0,
            [email.toLowerCase()],
          ])
        }
      }
      expect([nativeRefusal?.code, nativeRefusal?.message]).toEqual([
        'auth.invalid_credentials',
        'Invalid email or password',
      ])
      expect(got).toEqual(want)
      expect(await markerRow()).toEqual(markerBefore)
    })
  })
})

oldPlatformSignInSuite('sqlite', {
  open: (opts) => createKernel({ dialect: 'sqlite', ...opts }),
})
