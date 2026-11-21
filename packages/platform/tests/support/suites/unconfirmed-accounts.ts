import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { EVT_CUSTOMER_DELETED } from '@nymbalhq/types'
import type { EventPublisher } from '../../../src/events/publisher.js'
import type { CustomerRepository } from '../../../src/repositories/customer.js'
import { createLogger } from '../../../src/logger.js'
import { auditRows } from '../audit.js'
import type { Dialect } from '../kernel.js'
import { insertOrders } from '../listed-orders.js'
import type { AdminClient } from '../money.js'
import { maxSeq } from '../outbox.js'
import {
  delivered,
  login,
  mailedToken,
  msOf,
  neverIssued,
  sha256,
  type OpenStore,
  type PasswordStore,
} from '../password-reset.js'
import { writeRaw } from '../raw.js'
import { clockAt, openReplica } from '../replica.js'
import {
  age,
  credential,
  credentialCounts,
  customerRows,
  DAY_MS,
  daysBefore,
  deletionsOf,
  dropLinks,
  errorLines,
  liveRows,
  MINUTE_MS,
  PURGE_COMMAND,
  purgeEntriesOf,
  setVerification,
  sweepers,
} from '../unconfirmed-accounts.js'
import {
  accountStateOf,
  adminOf,
  confirmed,
  customerIdOf,
  expireLinks,
  MAIL_HEALTH,
  newAddress,
  newPassword,
  openVerificationStore,
  register,
  registeredUnasked,
  seeded,
  SENT,
  signedUp,
  verificationOf,
  verify,
  verifyMailsTo,
  verifyTokenIn,
  type SignedUp,
} from '../verification.js'
import { describeViolation, unaudited, writeAuditViolations } from '../write-audit.js'

// The purge of never-confirmed accounts on one dialect, on a verification store (tests/support/verification.ts) with
// the sweeper started by the test on a clock it sets. Rows aged past the grace are written from a second connection as
// the running service would have left them; links, sessions and orders through their repositories or the services.
// Races are forced, never timed.

export interface UnconfirmedAccountsSuiteOptions {
  open: OpenStore
  propertyRuns: number
}

/** Past the 30-day grace, with a day to spare. */
const IDLE_DAYS = 31
/** Inside the 30-day grace by a day, so a shortened grace removes it. */
const KEPT_IDLE_DAYS = 29

const said = (answer: { status: number; body: { error?: { code: string } } }) => [
  answer.status,
  answer.body.error?.code,
]

export function unconfirmedAccountsSuite(
  dialect: Dialect,
  options: UnconfirmedAccountsSuiteOptions,
): void {
  describe(`unconfirmed accounts under required (${dialect})`, () => {
    let s: PasswordStore
    let admin: AdminClient
    const sweeping = sweepers()

    beforeAll(async () => {
      s = await openVerificationStore(options.open, { verification: 'required' })
      admin = await adminOf(s)
    }, 60_000)

    afterEach(() => sweeping.stopAll())

    afterAll(async () => {
      await s?.close()
    })

    /** The ids the admin's customer list answers for a search on this address. */
    async function listedIds(email: string): Promise<string[]> {
      const answer = await admin.call<{ customers: Array<{ id: string }> }>(
        'GET',
        `/api/admin/customers?q=${encodeURIComponent(email)}&limit=200`,
      )
      expect(answer.status, 'the admin customer list').toBe(200)
      return answer.body.data!.customers.map((c) => c.id)
    }

    /** A signed-up account idle past the grace with no live link: a live session, an expired reset, its link ended. */
    async function makeDue(account: SignedUp, at: Date): Promise<void> {
      await expireLinks(s, account.customerId)
      await credential(s, 'refresh_tokens', account.customerId, new Date(at.getTime() + DAY_MS))
      await credential(s, 'password_reset_tokens', account.customerId, daysBefore(at, 2))
      await age(s, account.customerId, daysBefore(at, IDLE_DAYS))
    }

    describe('AC-1: one tick removes exactly the due accounts', () => {
      // Defect: the predicate misses a guard, reads created_at for the last write, reads order_count for orders, or
      // ignores a live link, so a kept account below is removed or written; or a due one is left.
      it('AC-1: a pending account idle 31 days with no link and one whose only link expired are removed; a confirmed, a support-confirmed, three never asked (seeded, off sign-up, imported), one created 40 days ago and re-registered 10 days ago, a pending one with no link idle 29 days, one with an unpaid and one with a paid order, one with support’s fresh link and one with a live reset link are each byte-equal after the tick', async () => {
        const noLink = await signedUp(s, 'ac1-no-link')
        const expiredLink = await signedUp(s, 'ac1-expired-link')
        const sure = await confirmed(s, 'ac1-confirmed')
        const marked = await signedUp(s, 'ac1-marked')
        const markedAnswer = await admin.call(
          'POST',
          `/api/admin/customers/${marked.customerId}/mark-verified`,
        )
        const seededAccount = await seeded(s, 'ac1-seeded')
        const unasked = await registeredUnasked(s, 'ac1-off')
        const imported = await s.k.services.auth.importCustomer({
          email: newAddress('ac1-imported'),
        })
        const reRegistered = await signedUp(s, 'ac1-re-registered')
        const inGrace = await signedUp(s, 'ac1-in-grace')
        const unpaid = await signedUp(s, 'ac1-unpaid')
        const paid = await signedUp(s, 'ac1-paid')
        await insertOrders(s.k, [
          { status: 'pending', customerId: unpaid.customerId },
          { status: 'confirmed', customerId: paid.customerId, capturedMinor: 1200 },
        ])
        await writeRaw(
          s.k.dialect,
          s.k.target,
          'UPDATE customers SET order_count = 1 WHERE id = ?',
          [paid.customerId],
        )
        const supportLink = await signedUp(s, 'ac1-support-link')
        const sent = await admin.call(
          'POST',
          `/api/admin/customers/${supportLink.customerId}/send-verification`,
        )
        const inFlight = await signedUp(s, 'ac1-reset')
        await mailedToken(s, inFlight.email)
        await delivered(s)
        // Every link is minted (a mint purges expired rows), so the links the matrix needs gone or ended go now.
        for (const account of [noLink, reRegistered, inGrace, unpaid, paid, inFlight]) {
          await dropLinks(s, account.customerId)
        }
        await expireLinks(s, expiredLink.customerId)
        const T = new Date(Date.now() + MINUTE_MS)
        const idle = daysBefore(T, IDLE_DAYS)
        const removed = { noLink: noLink.customerId, expiredLink: expiredLink.customerId }
        const kept = {
          confirmed: sure.customerId,
          markVerified: marked.customerId,
          seeded: seededAccount.customerId,
          offSignUp: unasked.customerId,
          imported: imported.id,
          unpaidOrder: unpaid.customerId,
          paidOrder: paid.customerId,
          supportLink: supportLink.customerId,
          resetInFlight: inFlight.customerId,
        }
        for (const id of [...Object.values(removed), ...Object.values(kept)]) await age(s, id, idle)
        await age(s, reRegistered.customerId, daysBefore(T, 40), daysBefore(T, 10))
        await age(s, inGrace.customerId, daysBefore(T, KEPT_IDLE_DAYS))
        const keptIds = {
          ...kept,
          reRegistered: reRegistered.customerId,
          inGrace: inGrace.customerId,
        }

        expect([markedAnswer.status, sent.status]).toEqual([200, 202])
        expect({
          expiredLink: [
            (await credentialCounts(s, expiredLink.customerId))[2],
            await liveRows(s, 'email_verification_tokens', expiredLink.customerId, T),
          ],
          supportLink: await liveRows(s, 'email_verification_tokens', supportLink.customerId, T),
          resetInFlight: await liveRows(s, 'password_reset_tokens', inFlight.customerId, T),
        }).toEqual({ expiredLink: [1, 0], supportLink: 1, resetInFlight: 1 })
        const statesOf = async (ids: Record<string, string>) => {
          const states: Record<string, unknown> = {}
          for (const [name, id] of Object.entries(ids)) states[name] = await accountStateOf(s, id)
          return states
        }
        const rowsOf = async (ids: Record<string, string>) => {
          const rows: Record<string, number> = {}
          for (const [name, id] of Object.entries(ids)) rows[name] = await customerRows(s, id)
          return rows
        }
        const keptBefore = await statesOf(keptIds)
        const removedBefore = await rowsOf(removed)

        await sweeping.start(s, { at: T }).tick()
        await delivered(s)

        expect(removedBefore).toEqual({ noLink: 1, expiredLink: 1 })
        expect(await rowsOf(removed)).toEqual({ noLink: 0, expiredLink: 0 })
        expect(await statesOf(keptIds)).toEqual(keptBefore)
      })
    })

    describe('AC-3: every due account goes with its event, its audit entry and its traces, across pages', () => {
      // Defect: the row goes with no event, credential rows stay, a removal has no audit entry, a later page's
      // removals are folded into the first entry, a projection or the admin keeps a ghost, or the log keeps the address.
      it('AC-3: with batchSize 2, five due accounts whose ids interleave with five kept ones are all removed in one tick: row, refresh, reset and verification rows gone, one customer.deleted.v1 { customerId } each, one applied entry by system:unconfirmed-accounts naming each, profile, list entry and admin read gone; the kept ones stay; no write-audit violation and no address in the pass’s log lines', async () => {
        const due: SignedUp[] = []
        const kept: SignedUp[] = []
        for (let i = 0; i < 5; i += 1) {
          due.push(await signedUp(s, `ac3-due-${i}`))
          kept.push(await signedUp(s, `ac3-kept-${i}`))
        }
        const T = new Date(Date.now() + MINUTE_MS)
        for (const account of due) await makeDue(account, T)
        const dueIds = new Set(due.map((a) => a.customerId))
        const order = [...due, ...kept]
          .map((a) => a.customerId)
          .sort()
          .map((id) => (dueIds.has(id) ? 'due' : 'kept'))
        const traceOf = async (account: SignedUp) => ({
          row: await customerRows(s, account.customerId),
          credentials: await credentialCounts(s, account.customerId),
          profile: (await s.k.documentStore.get('customer-profiles', account.customerId)) !== null,
          listed: (await listedIds(account.email)).includes(account.customerId),
        })
        const before = []
        for (const account of due) before.push(await traceOf(account))
        const keptRows = kept.map(() => 1)
        const mark = s.logs.length

        await sweeping.start(s, { at: T, batchSize: 2 }).tick()
        await delivered(s)

        const passLines = s.logs.slice(mark)
        expect(order).toEqual([
          'due',
          'kept',
          'due',
          'kept',
          'due',
          'kept',
          'due',
          'kept',
          'due',
          'kept',
        ])
        expect(before).toEqual(
          due.map(() => ({ row: 1, credentials: [1, 1, 1], profile: true, listed: true })),
        )
        const after = []
        for (const account of due) {
          const read = await admin.call('GET', `/api/admin/customers/${account.customerId}`)
          after.push({
            ...(await traceOf(account)),
            read: said(read),
            deletions: await deletionsOf(s, account.customerId),
            entries: (await purgeEntriesOf(s, account.customerId)).map((e) => ({
              actor: `${e.actorKind}:${e.actorId}`,
              command: e.command,
              outcome: e.outcome,
              names: e.subjects.some((x) => x.type === 'customer' && x.id === account.customerId),
            })),
          })
        }
        expect(after).toEqual(
          due.map((account) => ({
            row: 0,
            credentials: [0, 0, 0],
            profile: false,
            listed: false,
            read: [404, 'customers.not_found'],
            deletions: [{ customerId: account.customerId }],
            entries: [
              {
                actor: 'system:unconfirmed-accounts',
                command: PURGE_COMMAND,
                outcome: 'applied',
                names: true,
              },
            ],
          })),
        )
        const keptAfter = []
        for (const account of kept) keptAfter.push(await customerRows(s, account.customerId))
        expect(keptAfter).toEqual(keptRows)
        expect(writeAuditViolations().map(describeViolation)).toEqual([])
        expect(passLines.filter((line) => due.some((a) => line.includes(a.email)))).toEqual([])
      })
    })

    describe('AC-4: a removal happens once, whatever ticks again or races it', () => {
      // Defect: a second pass re-publishes or re-records what the first removed.
      it('AC-4: a second tick at the same instant removes nothing, publishes nothing and writes no audit entry', async () => {
        const T = new Date(Date.now() + MINUTE_MS)
        const accounts = [await signedUp(s, 'ac4-again-a'), await signedUp(s, 'ac4-again-b')]
        for (const account of accounts) await makeDue(account, T)
        const sweeper = sweeping.start(s, { at: T })
        const snapshot = async () => ({
          seq: await maxSeq(s.raw),
          entries: (await auditRows(s.raw)).length,
          customers: await s.raw.count('customers'),
        })

        await sweeper.tick()
        await delivered(s)
        const afterFirst = await snapshot()
        await sweeper.tick()
        await delivered(s)

        const rows = []
        for (const account of accounts) rows.push(await customerRows(s, account.customerId))
        expect(rows).toEqual([0, 0])
        expect(await snapshot()).toEqual(afterFirst)
      })

      // Defect: the delete is by id alone after a list, so two replicas each publish and record a deletion.
      it('AC-4: two sweepers on two command stores over one database ticking at once remove every due account once: one customer.deleted.v1 and one audit entry each, and no error logged', async () => {
        const T = new Date(Date.now() + MINUTE_MS)
        const accounts: SignedUp[] = []
        for (let i = 0; i < 6; i += 1) accounts.push(await signedUp(s, `ac4-replicas-${i}`))
        for (const account of accounts) await makeDue(account, T)
        const replicaLogs: string[] = []
        const replicaLogger = createLogger({
          pretty: false,
          level: 'trace',
          destination: { write: (line: string) => void replicaLogs.push(line) },
        })
        const replica = await openReplica(s.k.dialect, s.k.target, { clock: clockAt(T) })
        try {
          const a = sweeping.start(s, { at: T })
          const b = sweeping.start(s, {
            at: T,
            store: replica.store,
            repos: replica.repos,
            publisher: replica.publisher,
            logger: replicaLogger,
            verification: 'required',
          })
          const mark = s.logs.length

          await Promise.all([a.tick(), b.tick()])
          await delivered(s)

          const outcome = []
          for (const account of accounts) {
            outcome.push({
              row: await customerRows(s, account.customerId),
              deletions: (await deletionsOf(s, account.customerId)).length,
              entries: (await purgeEntriesOf(s, account.customerId)).length,
            })
          }
          expect(outcome).toEqual(accounts.map(() => ({ row: 0, deletions: 1, entries: 1 })))
          expect([...errorLines(s.logs.slice(mark)), ...errorLines(replicaLogs)]).toEqual([])
        } finally {
          await replica.close()
        }
      })

      // Defect: the delete trusts the list, so an account re-registered after it was listed is removed anyway.
      it('AC-4: a re-register of a due account committed between the list and the delete leaves it in place, with no customer.deleted.v1 and no audit entry for it, while the rest of its page is removed', async () => {
        const T = new Date(Date.now() + MINUTE_MS)
        const target = await signedUp(s, 'ac4-raced')
        const other = await signedUp(s, 'ac4-not-raced')
        for (const account of [target, other]) await makeDue(account, T)
        const real = s.k.repos.customer
        let raced = false
        // The list answers as it would; before the sweeper sees the answer, the shopper's re-register commits on a
        // connection of its own, as another request would.
        const customer: CustomerRepository = Object.assign(
          Object.create(real) as CustomerRepository,
          {
            async listUnconfirmed(...args: Parameters<CustomerRepository['listUnconfirmed']>) {
              const ids = await real.listUnconfirmed(...args)
              if (!raced && ids.includes(target.customerId)) {
                raced = true
                await writeRaw(
                  s.k.dialect,
                  s.k.target,
                  'UPDATE customers SET password_hash = ?, updated_at = ? WHERE id = ?',
                  [`re-registered-${randomUUID()}`, T.toISOString(), target.customerId],
                )
              }
              return ids
            },
          },
        )

        await sweeping.start(s, { at: T, repos: { ...s.k.repos, customer } }).tick()
        await delivered(s)

        expect(raced).toBe(true)
        expect({
          target: {
            row: await customerRows(s, target.customerId),
            updatedAt: msOf(
              (
                await s.raw.one<{ updated_at: unknown }>(
                  'SELECT updated_at FROM customers WHERE id = ?',
                  [target.customerId],
                )
              ).updated_at,
            ),
            deletions: await deletionsOf(s, target.customerId),
            entries: (await purgeEntriesOf(s, target.customerId)).length,
          },
          other: await customerRows(s, other.customerId),
        }).toEqual({
          target: {
            row: 1,
            updatedAt: T.getTime(),
            deletions: [],
            entries: 0,
          },
          other: 0,
        })
      })
    })

    describe('AC-5: an address whose account was removed registers again from scratch', () => {
      // Defect: the address stays taken (a row, a token or a cache left behind), or the new account inherits the old
      // id or its rows.
      it('AC-5: after a tick removed Shopper@X, a register for shopper@x answers the same 202 body as a new address, makes one pending account with a new id and one verify-email mail whose link signs in with the new password; the old id stays 404 to the admin', async () => {
        const tag = randomUUID().slice(0, 8)
        const original = `Ac5-${tag}@Verify.test`
        const again = `ac5-${tag}@VERIFY.TEST`
        const stored = original.toLowerCase()
        expect(
          (await register(s, { email: original, password: newPassword('ac5-old') })).status,
        ).toBe(202)
        await delivered(s)
        const oldId = await customerIdOf(s, stored)
        await dropLinks(s, oldId)
        const T = new Date(Date.now() + MINUTE_MS)
        await age(s, oldId, daysBefore(T, IDLE_DAYS))
        await sweeping.start(s, { at: T }).tick()
        await delivered(s)
        const removed = await customerRows(s, oldId)
        const mailsBefore = verifyMailsTo(s, stored).length
        const fresh = await register(s, {
          email: newAddress('ac5-new'),
          password: newPassword('ac5-new'),
        })

        const password = newPassword('ac5-again')
        const answer = await register(s, { email: again, password })
        await delivered(s)

        const newId = await customerIdOf(s, stored)
        const mails = verifyMailsTo(s, stored)
        const followed = await verify(s, verifyTokenIn(mails.at(-1)))
        await delivered(s)
        const signIn = await login(s, stored, password)
        const oldRead = await admin.call('GET', `/api/admin/customers/${oldId}`)

        expect(removed).toBe(0)
        expect([answer.status, answer.text]).toEqual([fresh.status, fresh.text])
        expect(answer.body).toEqual(SENT)
        expect(newId).not.toBe(oldId)
        expect(await s.raw.count('customers', 'email = ?', [stored])).toBe(1)
        expect(mails.length - mailsBefore).toBe(1)
        expect([followed.status, signIn.status, signIn.body.data?.customer?.id]).toEqual([
          200,
          200,
          newId,
        ])
        expect(await verificationOf(s, newId)).toBe('verified')
        expect(said(oldRead)).toEqual([404, 'customers.not_found'])
        expect(await credentialCounts(s, oldId)).toEqual([0, 0, 0])
      })
    })

    describe('AC-7: the mail funnel keeps its seven days', () => {
      // Defect: the grace is shortened below the funnel's 7 days, so a store whose mail is lost purges the sign-ups
      // that would have raised the "N of M never confirmed" warning.
      it('AC-7: at the real now, a pending account and a confirmed one created 7 days less a minute ago are untouched and mail-health answers the same funnel after the tick, while a due account is removed', async () => {
        const pending = await signedUp(s, 'ac7-pending')
        const sure = await confirmed(s, 'ac7-confirmed')
        const due = await signedUp(s, 'ac7-due')
        await dropLinks(s, pending.customerId)
        await dropLinks(s, due.customerId)
        const T = new Date()
        const window = new Date(T.getTime() - 7 * DAY_MS + MINUTE_MS)
        await age(s, pending.customerId, window)
        await age(s, sure.customerId, window)
        await age(s, due.customerId, daysBefore(T, IDLE_DAYS))
        const funnel = async () =>
          (await admin.call<{ funnel: unknown }>('GET', MAIL_HEALTH)).body.data?.funnel
        const before = {
          funnel: await funnel(),
          pending: await accountStateOf(s, pending.customerId),
          confirmed: await accountStateOf(s, sure.customerId),
        }

        await sweeping.start(s, { at: T }).tick()
        await delivered(s)

        expect({
          funnel: await funnel(),
          pending: await accountStateOf(s, pending.customerId),
          confirmed: await accountStateOf(s, sure.customerId),
        }).toEqual(before)
        expect(await customerRows(s, due.customerId)).toBe(0)
      })
    })

    describe('AC-9: one failed removal does not stop the pass', () => {
      // Defect: a rejection escapes the tick (an unhandled rejection from setInterval ends the process), the pass
      // stops at the first failure so every later account is never removed, or the page cursor stays on a failed
      // account so the pass lists it forever and never ends.
      it('AC-9: with batchSize 1 and a publisher that rejects for the second of three due accounts, the tick resolves; that account and its credential rows are byte-equal with no event and no entry; the other two are removed with theirs; one error line names the failed id as customerId and no line an address; the next tick with a healthy publisher removes it', async () => {
        const T = new Date(Date.now() + MINUTE_MS)
        const accounts: SignedUp[] = []
        for (let i = 0; i < 3; i += 1) accounts.push(await signedUp(s, `ac9-${i}`))
        for (const account of accounts) await makeDue(account, T)
        const [first, failed, third] = [...accounts].sort((a, b) =>
          a.customerId < b.customerId ? -1 : 1,
        ) as [SignedUp, SignedUp, SignedUp]
        let rejecting = true
        const failing = (inner: EventPublisher): EventPublisher => ({
          publish(type, payload, opts) {
            if (
              rejecting &&
              type === EVT_CUSTOMER_DELETED &&
              (payload as { customerId?: string }).customerId === failed.customerId
            ) {
              return Promise.reject(new Error('the event log is unavailable'))
            }
            return inner.publish(type, payload, opts)
          },
          publishMany: (events) => inner.publishMany(events),
          publishUntyped: (events, opts) => inner.publishUntyped(events, opts),
          correlated: (correlationId) => failing(inner.correlated(correlationId)),
        })
        // A cursor that stays on the failed account lists it on every page, and the pass never yields to a timer;
        // past a bound the list answers empty, so that pass ends and its repeated failures are counted below.
        const real = s.k.repos.customer
        let pages = 0
        const customer: CustomerRepository = Object.assign(
          Object.create(real) as CustomerRepository,
          {
            async listUnconfirmed(...args: Parameters<CustomerRepository['listUnconfirmed']>) {
              pages += 1
              return pages > 50 ? [] : real.listUnconfirmed(...args)
            },
          },
        )
        const failedBefore = await accountStateOf(s, failed.customerId)
        const sweeper = sweeping.start(s, {
          at: T,
          batchSize: 1,
          repos: { ...s.k.repos, customer },
          publisher: failing(s.k.publisher),
        })
        const mark = s.logs.length

        await expect(sweeper.tick()).resolves.toBeUndefined()
        await delivered(s)

        const passLines = s.logs.slice(mark)
        expect({
          failed: {
            state: await accountStateOf(s, failed.customerId),
            deletions: await deletionsOf(s, failed.customerId),
            entries: (await purgeEntriesOf(s, failed.customerId)).length,
          },
          first: [
            await customerRows(s, first.customerId),
            ...(await credentialCounts(s, first.customerId)),
          ],
          third: [
            await customerRows(s, third.customerId),
            ...(await credentialCounts(s, third.customerId)),
          ],
        }).toEqual({
          failed: { state: failedBefore, deletions: [], entries: 0 },
          first: [0, 0, 0, 0],
          third: [0, 0, 0, 0],
        })
        const failures = errorLines(passLines)
        expect(
          failures.map((line) => {
            const { level, customerId } = JSON.parse(line) as { level: number; customerId?: string }
            return { level, customerId, address: accounts.some((a) => line.includes(a.email)) }
          }),
        ).toEqual([{ level: 50, customerId: failed.customerId, address: false }])
        expect(passLines.filter((line) => accounts.some((a) => line.includes(a.email)))).toEqual([])

        rejecting = false
        await sweeper.tick()
        await delivered(s)

        expect({
          row: await customerRows(s, failed.customerId),
          credentials: await credentialCounts(s, failed.customerId),
          deletions: await deletionsOf(s, failed.customerId),
        }).toEqual({
          row: 0,
          credentials: [0, 0, 0],
          deletions: [{ customerId: failed.customerId }],
        })
      })
    })
  })

  describe(`unconfirmed accounts under off (${dialect})`, () => {
    let s: PasswordStore
    const sweeping = sweepers()

    beforeAll(async () => {
      s = await openVerificationStore(options.open, { verification: 'off' })
    }, 60_000)

    afterEach(() => sweeping.stopAll())

    afterAll(async () => {
      await s?.close()
    })

    // Defect: the purge deletes pending accounts on a store where they sign in, so a shopper's working account
    // vanishes.
    it('AC-6: under off, a tick over pending accounts idle 31 days (no link, an expired link, an unpaid order) and confirmed and never-asked ones removes nothing and publishes nothing', async () => {
      const T = new Date(Date.now() + MINUTE_MS)
      const noLink = await registeredUnasked(s, 'ac6-no-link')
      const expiredLink = await registeredUnasked(s, 'ac6-expired-link')
      const unpaid = await registeredUnasked(s, 'ac6-unpaid')
      const sure = await registeredUnasked(s, 'ac6-confirmed')
      const unasked = await registeredUnasked(s, 'ac6-unasked')
      const seededAccount = await seeded(s, 'ac6-seeded')
      const imported = await s.k.services.auth.importCustomer({ email: newAddress('ac6-imported') })
      await delivered(s)
      for (const account of [noLink, expiredLink, unpaid]) {
        await setVerification(s, account.customerId, 'pending')
      }
      await setVerification(s, sure.customerId, 'verified')
      await credential(s, 'email_verification_tokens', expiredLink.customerId, daysBefore(T, 2))
      await insertOrders(s.k, [{ status: 'pending', customerId: unpaid.customerId }])
      const ids = {
        noLink: noLink.customerId,
        expiredLink: expiredLink.customerId,
        unpaid: unpaid.customerId,
        confirmed: sure.customerId,
        unasked: unasked.customerId,
        seeded: seededAccount.customerId,
        imported: imported.id,
      }
      for (const id of Object.values(ids)) await age(s, id, daysBefore(T, IDLE_DAYS))
      const statesOf = async () => {
        const states: Record<string, unknown> = {}
        for (const [name, id] of Object.entries(ids)) states[name] = await accountStateOf(s, id)
        return states
      }
      const before = { states: await statesOf(), seq: await maxSeq(s.raw) }

      await sweeping.start(s, { at: T }).tick()
      await delivered(s)

      expect(s.k.services.auth.verification).toBe('off')
      expect({ states: await statesOf(), seq: await maxSeq(s.raw) }).toEqual(before)
      expect(await auditRows(s.raw, 'command = ?', [PURGE_COMMAND])).toEqual([])
    })
  })

  describe(`the due predicate at the repository (${dialect})`, () => {
    let s: PasswordStore

    beforeAll(async () => {
      s = await openVerificationStore(options.open, { verification: 'required' })
    }, 60_000)

    afterAll(async () => {
      await s?.close()
    })

    // Defect: the cut-off or a link's expiry is off by one, paging skips or repeats an account, or the conditional
    // delete re-checks only updated_at and so removes an account whose link was minted after it was listed.
    it('AC-2: property: over verification null, pending or verified, updated_at at, just before or just after `before`, 0-2 orders and 0-2 links and resets expiring at, just before or just after `now`, listUnconfirmed across pages of 1-5 answers exactly the due ids once each, ascending, and deleteUnconfirmed answers true exactly for a due account and leaves every other row and its links byte-equal', async () => {
      const offset = fc.constantFrom(-1, 0, 1)
      const account = fc.record({
        verification: fc.constantFrom(null, 'pending' as const, 'verified' as const),
        updated: offset,
        orders: fc.integer({ min: 0, max: 2 }),
        links: fc.array(offset, { maxLength: 2 }),
        resets: fc.array(offset, { maxLength: 2 }),
      })
      type Account = typeof account extends fc.Arbitrary<infer A> ? A : never
      const isDue = (a: Account) =>
        a.verification === 'pending' &&
        a.updated < 0 &&
        a.orders === 0 &&
        [...a.links, ...a.resets].every((o) => o <= 0)
      // Each run sits 400 days before the last, so every earlier run's account was made and written after this run's
      // cut-off. Every account was made 100 days before its cut-off, so only its last write can keep it.
      const origin = Date.UTC(2001, 0, 1)
      let run = 0

      await fc.assert(
        fc.asyncProperty(
          fc.array(account, { minLength: 1, maxLength: 8 }),
          fc.integer({ min: 1, max: 5 }),
          async (accounts, limit) => {
            run += 1
            const before = new Date(origin - run * 400 * DAY_MS)
            const now = new Date(before.getTime() + 30 * DAY_MS)
            const written = accounts.map((a) => ({ ...a, id: randomUUID() }))
            for (const a of written) {
              const updatedAt = new Date(before.getTime() + a.updated)
              await unaudited(() =>
                s.k.store.transaction(async (tx) => {
                  await s.k.repos.customer.insert(tx, {
                    id: a.id,
                    email: `${a.id}@due.test`,
                    passwordHash: `unused-${a.id}`,
                    ...(a.verification !== null && { emailVerification: 'pending' as const }),
                    createdAt: new Date(before.getTime() - 100 * DAY_MS),
                    updatedAt,
                  })
                  if (a.verification === 'verified') {
                    await s.k.repos.customer.update(tx, a.id, {
                      emailVerification: 'verified',
                      updatedAt,
                    })
                  }
                  for (const [repo, offsets] of [
                    [s.k.repos.emailVerificationToken, a.links],
                    [s.k.repos.passwordResetToken, a.resets],
                  ] as const) {
                    for (const o of offsets) {
                      await repo.insert(tx, {
                        id: uuidv7(),
                        customerId: a.id,
                        tokenHash: sha256(neverIssued()),
                        expiresAt: new Date(now.getTime() + o),
                        createdAt: before,
                      })
                    }
                  }
                }),
              )
              if (a.orders > 0) {
                await insertOrders(
                  s.k,
                  Array.from({ length: a.orders }, () => ({
                    status: 'pending' as const,
                    customerId: a.id,
                  })),
                )
              }
            }
            const due = written
              .filter(isDue)
              .map((a) => a.id)
              .sort()

            const listed: string[] = []
            let after: string | undefined
            // Bounded, so a list that ignores `after` repeats into the assertion instead of looping.
            for (let page = 0; page <= written.length + 1; page += 1) {
              const ids: string[] = await s.k.store.read((tx) =>
                s.k.repos.customer.listUnconfirmed(tx, {
                  before,
                  now,
                  ...(after !== undefined && { after }),
                  limit,
                }),
              )
              expect(ids.length).toBeLessThanOrEqual(limit)
              listed.push(...ids)
              if (ids.length < limit) break
              after = ids.at(-1)
            }
            expect(listed).toEqual(due)

            const kept = written.filter((a) => !isDue(a))
            const keptBefore = []
            for (const a of kept) keptBefore.push(await accountStateOf(s, a.id))
            const answers = []
            for (const a of written) {
              answers.push(
                await unaudited(() =>
                  s.k.store.transaction((tx) =>
                    s.k.repos.customer.deleteUnconfirmed(tx, a.id, { before, now }),
                  ),
                ),
              )
            }
            const keptAfter = []
            for (const a of kept) keptAfter.push(await accountStateOf(s, a.id))
            const dueRows = []
            for (const id of due) dueRows.push(await customerRows(s, id))

            expect(answers).toEqual(written.map(isDue))
            expect(keptAfter).toEqual(keptBefore)
            expect(dueRows).toEqual(due.map(() => 0))
          },
        ),
        { numRuns: options.propertyRuns },
      )
    })
  })
}
