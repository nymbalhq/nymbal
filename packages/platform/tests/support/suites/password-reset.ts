import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderEmailTemplate, type NymbalEvent } from '@nymbalhq/types'
import { cartWith, seedVariant, type Dialect } from '../kernel.js'
import { eventRows, maxSeq } from '../outbox.js'
import { writeRaw } from '../raw.js'
import {
  allResetRows,
  customerRowOf,
  delivered,
  forgot,
  jtiOf,
  liveRefreshOf,
  logLinesHolding,
  login,
  mailedToken,
  me,
  msOf,
  neverIssued,
  openPasswordStore,
  refresh,
  refreshRowsOf,
  registered,
  reset,
  RESET_LINK,
  RESET_MAIL,
  RESET_REQUESTED,
  RESET_TTL_MS,
  resetMailsTo,
  resetRowsOf,
  retried,
  SAME_ANSWER,
  said,
  settled,
  sha256,
  stateOf,
  tablesHolding,
  tokenIn,
  truthy,
  warnLines,
  type OpenStore,
  type PasswordStore,
} from '../password-reset.js'

// "Forgot password?" on one dialect, over HTTP against a kernel built from `src/` (tests/support/password-reset.ts).
// A request answers 202 with one body whatever the address; a registered customer gets one mail whose link carries a
// token only the mail holds (its SHA-256 is all the store keeps), live for 15 minutes; the link sets a password once and
// signs the shopper in; an unknown, used or expired link gets one refusal; a reset ends every earlier session. Races
// are forced, never timed.

export interface PasswordResetSuiteOptions {
  open: OpenStore
  propertyRuns: number
}

const SHORT = 'seven77'
const INVALID = 'auth.reset_link_invalid'

export function passwordResetSuite(dialect: Dialect, options: PasswordResetSuiteOptions): void {
  describe(`password reset (${dialect})`, () => {
    let s: PasswordStore

    beforeAll(async () => {
      s = await openPasswordStore(options.open)
    }, 60_000)

    afterAll(async () => {
      await s?.close()
    })

    describe('AC-7: a forgot request answers alike for every address', () => {
      // Defect: the route answers differently by account, or publishes for a missing customer.
      it('AC-7: a registered, an unknown, an imported and a differently-cased address each get 202 and one byte-equal body; the unknown one writes no row and publishes no event', async () => {
        const owner = await registered(s, 'ac7-owner')
        const cased = await registered(s, 'ac7-cased')
        const imported = `ac7-imported-${randomUUID().slice(0, 8)}@reset.test`
        await s.k.services.auth.importCustomer({ email: imported })
        await delivered(s)
        const unknown = `ac7-nobody-${randomUUID().slice(0, 8)}@reset.test`

        const answers = [
          await forgot(s, owner.email),
          await forgot(s, imported),
          await forgot(s, cased.email.toUpperCase()),
        ]
        await delivered(s)
        const rowsBefore = await allResetRows(s)
        const seqBefore = await maxSeq(s.raw)
        answers.push(await forgot(s, unknown))
        await delivered(s)

        expect(answers.map((a) => a.status)).toEqual([202, 202, 202, 202])
        expect(answers[0]!.body).toEqual(SAME_ANSWER)
        expect(
          new Set(answers.map((a) => a.text)).size,
          answers.map((a) => a.text).join(' | '),
        ).toBe(1)
        expect(await allResetRows(s)).toBe(rowsBefore)
        expect(await maxSeq(s.raw)).toBe(seqBefore)
      })
    })

    describe('AC-8: the mail carries a token the store keeps only as a hash', () => {
      // Defect: the token is stored or carried in the event, the link is built without store.url, or the TTL is
      // another number.
      it('AC-8: a registered address gets one password-reset mail linking <store.url>/account/reset-password#token=<43 base64url chars>; the row holds the token’s SHA-256 and expires 15 minutes after it was made; the event carries only the customer; the token is in no table, event or log line', async () => {
        const owner = await registered(s, 'ac8')
        await delivered(s)
        const seq = await maxSeq(s.raw)
        const mailsBefore = s.mail.sent.filter((m) => m.to === owner.email).length

        const answer = await forgot(s, owner.email)
        await delivered(s)

        expect(answer.status).toBe(202)
        const mails = s.mail.sent.filter((m) => m.to === owner.email).slice(mailsBefore)
        expect(mails.map((m) => m.template)).toEqual([RESET_MAIL])
        const url = String(mails[0]!.vars['resetUrl'])
        expect(url).toMatch(RESET_LINK)
        const token = tokenIn(mails[0])
        expect(Number(mails[0]!.vars['expiresMinutes'])).toBe(RESET_TTL_MS / 60_000)
        const rendered = renderEmailTemplate(RESET_MAIL, mails[0]!.vars)
        expect(rendered.text).toContain(url)
        expect(rendered.subject).not.toBe(`[nymbal] ${RESET_MAIL}`)

        const rows = await resetRowsOf(s, owner.customerId)
        expect(rows.map((r) => r.token_hash)).toEqual([sha256(token)])
        expect(msOf(rows[0]!.expires_at) - msOf(rows[0]!.created_at)).toBe(RESET_TTL_MS)

        const events = (await eventRows(s.raw, 'seq > ? AND type = ?', [seq, RESET_REQUESTED])).map(
          (e) => (e.envelope as NymbalEvent<unknown>).payload,
        )
        expect(events).toEqual([{ customerId: owner.customerId }])
        expect(await tablesHolding(s, token)).toEqual([])
        expect(logLinesHolding(s, token)).toEqual([])
      })
    })

    describe('AC-9: one live link per account', () => {
      // Defect: every press mails, or a live link is replaced.
      it('AC-9: a second request while the link is live sends no mail and adds no row; once the link has expired, and once it is used, a request sends one mail and the new link’s hash is the live row', async () => {
        const owner = await registered(s, 'ac9')
        const first = await mailedToken(s, owner.email)
        const rowsAfterFirst = await resetRowsOf(s, owner.customerId)

        await forgot(s, owner.email)
        await delivered(s)
        const whileLive = {
          mails: resetMailsTo(s, owner.email).length,
          rows: await resetRowsOf(s, owner.customerId),
        }

        await writeRaw(
          s.k.dialect,
          s.k.target,
          'UPDATE password_reset_tokens SET expires_at = created_at WHERE customer_id = ?',
          [owner.customerId],
        )
        const afterExpiry = await mailedToken(s, owner.email)
        const used = await reset(s, afterExpiry, `ac9-new-${randomUUID()}`)
        const afterUse = await mailedToken(s, owner.email)

        expect(whileLive.mails).toBe(1)
        expect(whileLive.rows).toEqual(rowsAfterFirst)
        expect(new Set([first, afterExpiry, afterUse]).size).toBe(3)
        expect(used.status).toBe(200)
        expect((await resetRowsOf(s, owner.customerId)).map((r) => r.token_hash)).toEqual([
          sha256(afterUse),
        ])
      })
    })

    describe('AC-10: mail goes only where it can arrive, and only with a link', () => {
      // Defect: the handler sends to a placeholder.
      it('AC-10: a customer at a nymbal.local placeholder address gets no mail and no row, and the answer is the same 202', async () => {
        const owner = await registered(s, 'ac10-real')
        const placeholder = `ac10-${randomUUID().slice(0, 8)}@nymbal.local`
        const imported = await s.k.services.auth.importCustomer({ email: placeholder })
        await delivered(s)

        const real = await forgot(s, owner.email)
        const answer = await forgot(s, placeholder)
        await delivered(s)

        expect(answer.text).toBe(real.text)
        expect(s.mail.attempts.filter((m) => m.to === placeholder)).toEqual([])
        expect(await resetRowsOf(s, imported.id)).toEqual([])
        expect(resetMailsTo(s, owner.email)).toHaveLength(1)
      })

      // Defect: it applies alert-mail suppression to a transactional mail.
      it('AC-10: an address on the suppression list still gets its reset mail', async () => {
        const owner = await registered(s, 'ac10-suppressed')
        await s.k.store.transaction((tx) =>
          s.k.repos.emailSuppression.suppress(tx, {
            email: owner.email,
            reason: 'hard_bounce',
            eventId: uuidv7(),
            at: new Date(),
          }),
        )

        await forgot(s, owner.email)
        await delivered(s)

        expect(resetMailsTo(s, owner.email)).toHaveLength(1)
        expect((await resetRowsOf(s, owner.customerId)).map((r) => r.token_hash)).toEqual([
          sha256(tokenIn(resetMailsTo(s, owner.email)[0])),
        ])
      })
    })

    describe('AC-11: the link sets a password once and signs the shopper in', () => {
      // Defect: the link is reusable, or does not sign in, or the password write and the consumption are not one
      // transaction.
      it('AC-11: with the mail’s token, reset answers 200 with a session (an access token that reads the account, a refresh cookie that refreshes, the guest cart claimed as at login); the old password is then refused and the new one signs in; the same token again answers 400 auth.reset_link_invalid and writes nothing', async () => {
        const owner = await registered(s, 'ac11')
        const guestCart = await cartWith(s.k, await seedVariant(s.k, 10), 1)
        const token = await mailedToken(s, owner.email)
        const next = `ac11-new-${randomUUID()}`

        const answer = await reset(s, token, next, { cookies: { 'nymbal.cart': guestCart } })

        expect(answer.status, answer.text).toBe(200)
        expect(answer.body.data?.customer?.id).toBe(owner.customerId)
        const account = await me(s, answer.body.data!.accessToken!)
        expect([account.status, (account.body.data as { id?: string } | undefined)?.id]).toEqual([
          200,
          owner.customerId,
        ])
        expect((await refresh(s, answer.refreshCookie!)).status).toBe(200)
        expect((await s.k.services.cart.get(guestCart))?.customerId).toBe(owner.customerId)
        expect((await login(s, owner.email, owner.password)).status).toBe(401)
        expect((await login(s, owner.email, next)).status).toBe(200)

        const before = { state: await stateOf(s, owner.customerId), seq: await maxSeq(s.raw) }
        const again = await reset(s, token, `ac11-again-${randomUUID()}`)
        await delivered(s)

        expect(said(again)).toEqual([400, INVALID])
        expect({ state: await stateOf(s, owner.customerId), seq: await maxSeq(s.raw) }).toEqual(
          before,
        )
      })
    })

    describe('AC-12: a link is live until the instant it expires', () => {
      // Defect: expiry is off by one or not checked.
      it('AC-12: property: at the repository, with an explicit now, findLive and consume take a row at expires_at minus 1 ms or earlier and refuse it at expires_at and after, consume then deleting nothing', async () => {
        const owner = await registered(s, 'ac12-repo')
        const repo = s.k.repos.passwordResetToken
        await fc.assert(
          fc.asyncProperty(
            fc.oneof(
              fc.integer({ min: -3, max: 3 }),
              fc.integer({ min: -RESET_TTL_MS, max: RESET_TTL_MS }),
            ),
            async (offset) => {
              const token = neverIssued()
              const expiresAt = new Date(Date.now() + RESET_TTL_MS)
              await s.k.store.transaction((tx) =>
                repo.insert(tx, {
                  id: uuidv7(),
                  customerId: owner.customerId,
                  tokenHash: sha256(token),
                  expiresAt,
                  createdAt: new Date(expiresAt.getTime() - RESET_TTL_MS),
                }),
              )
              const at = new Date(expiresAt.getTime() + offset)
              const live = offset < 0

              const found = await s.k.store.transaction((tx) =>
                repo.findLive(tx, sha256(token), at),
              )
              const consumed = await s.k.store.transaction((tx) =>
                repo.consume(tx, sha256(token), at),
              )
              const left = await s.raw.count('password_reset_tokens', 'token_hash = ?', [
                sha256(token),
              ])

              expect(found?.customerId ?? null, `offset ${offset}`).toBe(
                live ? owner.customerId : null,
              )
              expect(consumed, `offset ${offset}`).toBe(live ? owner.customerId : null)
              expect(left, `offset ${offset}`).toBe(live ? 0 : 1)
            },
          ),
          { numRuns: Math.max(options.propertyRuns, 12), examples: [[-1], [0], [1]] },
        )
      })

      // Defect: the answers differ and reveal which tokens were ever real.
      it('AC-12: an unknown, a used and an expired token get byte-equal 400 auth.reset_link_invalid bodies, and the customer’s hash is untouched', async () => {
        const used = await registered(s, 'ac12-used')
        const usedToken = await mailedToken(s, used.email)
        expect((await reset(s, usedToken, `ac12-first-${randomUUID()}`)).status).toBe(200)
        const expired = await registered(s, 'ac12-expired')
        const expiredToken = neverIssued()
        await s.k.store.transaction((tx) =>
          s.k.repos.passwordResetToken.insert(tx, {
            id: uuidv7(),
            customerId: expired.customerId,
            tokenHash: sha256(expiredToken),
            expiresAt: new Date(Date.now() - 60_000),
            createdAt: new Date(Date.now() - 60_000 - RESET_TTL_MS),
          }),
        )
        const hashes = {
          used: (await customerRowOf(s, used.customerId)).password_hash,
          expired: (await customerRowOf(s, expired.customerId)).password_hash,
        }

        const answers = [
          await reset(s, neverIssued(), `ac12-${randomUUID()}`),
          await reset(s, usedToken, `ac12-${randomUUID()}`),
          await reset(s, expiredToken, `ac12-${randomUUID()}`),
        ]

        expect(answers.map(said)).toEqual([
          [400, INVALID],
          [400, INVALID],
          [400, INVALID],
        ])
        expect(new Set(answers.map((a) => a.text)).size).toBe(1)
        expect({
          used: (await customerRowOf(s, used.customerId)).password_hash,
          expired: (await customerRowOf(s, expired.customerId)).password_hash,
        }).toEqual(hashes)
      })
    })

    describe('AC-13: a link is used once, however many presses race', () => {
      // Defect: single use is a read-then-delete, so two requests both succeed.
      it('AC-13: property: k resets with one token at once give exactly one 200 and k - 1 400s, one new session, and a stored hash that verifies the winner’s password only', async () => {
        await fc.assert(
          fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (k) => {
            const owner = await registered(s, 'ac13')
            const token = await mailedToken(s, owner.email)
            const passwords = Array.from({ length: k }, (_, i) => `ac13-${i}-${randomUUID()}`)
            const sessionRowsBefore = (await refreshRowsOf(s, owner.customerId)).length

            const answers = await Promise.all(passwords.map((p) => reset(s, token, p)))

            const winners = passwords.filter((_, i) => answers[i]!.status === 200)
            const losers = answers.filter((a) => a.status !== 200)
            expect(winners, answers.map((a) => a.text).join(' | ')).toHaveLength(1)
            expect(losers.map(said)).toEqual(losers.map(() => [400, INVALID]))
            const hash = (await customerRowOf(s, owner.customerId)).password_hash
            expect(await Promise.all(passwords.map((p) => bcrypt.compare(p, hash)))).toEqual(
              passwords.map((p) => p === winners[0]),
            )
            // One new session, the winner's, and it is the one live.
            expect((await refreshRowsOf(s, owner.customerId)).length).toBe(sessionRowsBefore + 1)
            expect(await liveRefreshOf(s, owner.customerId)).toEqual([
              jtiOf(answers.find((a) => a.status === 200)!.refreshCookie!),
            ])
          }),
          { numRuns: options.propertyRuns },
        )
      }, 120_000)
    })

    describe('AC-14: a password too short leaves the link usable', () => {
      // Defect: the length is checked after the token is consumed, so a typo burns the link.
      it('AC-14: a new password under 8 characters answers 400 validation.failed and writes nothing; the same link then sets a valid password', async () => {
        const owner = await registered(s, 'ac14')
        const token = await mailedToken(s, owner.email)
        const before = await stateOf(s, owner.customerId)

        const short = await reset(s, token, SHORT)
        const after = await stateOf(s, owner.customerId)
        const valid = await reset(s, token, `ac14-${randomUUID()}`)

        expect(said(short)).toEqual([400, 'validation.failed'])
        expect(after).toEqual(before)
        expect(valid.status, valid.text).toBe(200)
      })
    })

    describe('AC-15: a reset ends every earlier session', () => {
      // Defect: the reset skips the revoke; or a replay of a swept token runs revokeAllForCustomer and ends the session
      // the reset created.
      it('AC-15: after a reset every refresh token issued before it is refused, a token rotated inside its 30 s window included, and the new session is the only live row; presenting the old rotated token leaves the new session able to refresh', async () => {
        const owner = await registered(s, 'ac15')
        const rotatedFrom = owner.refreshToken
        const rotatedTo = (await s.k.services.auth.refresh(rotatedFrom)).refreshToken
        const other = (await s.k.services.auth.login(owner.email, owner.password)).tokens
          .refreshToken
        const token = await mailedToken(s, owner.email)

        const answer = await reset(s, token, `ac15-${randomUUID()}`)
        const live = await liveRefreshOf(s, owner.customerId)
        const earlier = [
          await refresh(s, rotatedFrom),
          await refresh(s, rotatedTo),
          await refresh(s, other),
        ]
        const fresh = await refresh(s, answer.refreshCookie!)

        expect(answer.status, answer.text).toBe(200)
        expect(live).toEqual([jtiOf(answer.refreshCookie!)])
        expect(earlier.map((a) => a.status)).toEqual([401, 401, 401])
        expect(fresh.status, fresh.text).toBe(200)
      })
    })

    describe('AC-16: an imported customer sets a first password through the link', () => {
      // Defect: a failed login mails (an email bomb on any imported address), or the flag stays set.
      it('AC-16: ten failed sign-ins send no mail and answer the generic 401; Forgot password sends one; the reset signs them in, clears requiresPasswordReset and replaces the sentinel', async () => {
        const email = `ac16-${randomUUID().slice(0, 8)}@reset.test`
        const imported = await s.k.services.auth.importCustomer({ email })
        await delivered(s)
        const unknown = await login(
          s,
          `ac16-nobody-${randomUUID().slice(0, 8)}@reset.test`,
          'whatever-it-is',
        )

        const failures = []
        for (let i = 0; i < 10; i += 1) failures.push(await login(s, email, `guess-${i}-password`))
        await delivered(s)
        const mailsAfterFailures = s.mail.attempts.filter((m) => m.to === email).length
        const token = await mailedToken(s, email)
        const next = `ac16-${randomUUID()}`
        const answer = await reset(s, token, next)
        const row = await customerRowOf(s, imported.id)

        expect(failures.map((f) => [f.status, f.text])).toEqual(
          failures.map(() => [401, unknown.text]),
        )
        expect(mailsAfterFailures).toBe(0)
        expect(resetMailsTo(s, email)).toHaveLength(1)
        expect([answer.status, answer.body.data?.customer?.id]).toEqual([200, imported.id])
        expect(truthy(row.requires_password_reset)).toBe(false)
        expect(row.password_hash).not.toBe('IMPORTED_NO_PASSWORD')
        expect(await bcrypt.compare(next, row.password_hash)).toBe(true)
      })
    })

    describe('AC-17: rows die with their customer, and expired rows with the next request', () => {
      // Defect: a removed customer's token stays usable or a dead row is never collected.
      it('AC-17: a request purges the expired rows, its customer’s and another’s, leaving its own live row; removing the customer deletes their rows and their link answers 400', async () => {
        const owner = await registered(s, 'ac17-owner')
        const other = await registered(s, 'ac17-other')
        for (const customerId of [owner.customerId, other.customerId]) {
          await s.k.store.transaction((tx) =>
            s.k.repos.passwordResetToken.insert(tx, {
              id: uuidv7(),
              customerId,
              tokenHash: sha256(neverIssued()),
              expiresAt: new Date(Date.now() - 1_000),
              createdAt: new Date(Date.now() - 1_000 - RESET_TTL_MS),
            }),
          )
        }

        const token = await mailedToken(s, owner.email)
        const afterRequest = {
          owner: (await resetRowsOf(s, owner.customerId)).map((r) => r.token_hash),
          other: await resetRowsOf(s, other.customerId),
        }
        const removed = await s.k.services.importRemoval.removeCustomer(owner.customerId)
        await delivered(s)

        expect(afterRequest).toEqual({ owner: [sha256(token)], other: [] })
        expect(removed).toBe('removed')
        expect(await resetRowsOf(s, owner.customerId)).toEqual([])
        expect(said(await reset(s, token, `ac17-${randomUUID()}`))).toEqual([400, INVALID])
      })
    })
  })

  describe(`password reset mail delivery (${dialect})`, () => {
    let s: PasswordStore
    const twice = { on: false }

    beforeAll(async () => {
      s = await openPasswordStore(options.open, { retry: true })
      // At-least-once: while `twice.on`, the bus hands every event to the subscribers twice.
      const bus = s.k.eventBus
      const publish = bus.publish.bind(bus)
      bus.publish = async function <T>(event: NymbalEvent<T>): Promise<void> {
        await publish(event)
        if (twice.on) await publish(event)
      }
    }, 60_000)

    afterAll(async () => {
      await s?.close()
    })

    // Defect: a retried send is blocked by its own row, so a mail outage loses the link.
    it('AC-9: a send that throws leaves no live row; the relay’s retry sends exactly one mail, whose token is the live row, and the failed send’s token opens nothing', async () => {
      twice.on = false
      const owner = await registered(s, 'ac9-outage')
      // The welcome mail goes first, so the refusal falls on the reset mail.
      await settled(s)
      s.mail.refuse.set(owner.email, 1)
      const resetAttempts = () =>
        s.mail.attempts.filter((m) => m.to === owner.email && m.template === RESET_MAIL)

      await forgot(s, owner.email)
      await settled(s)
      const afterFailure = {
        attempts: resetAttempts().length,
        rows: await resetRowsOf(s, owner.customerId),
      }
      await retried(s)

      expect(afterFailure).toEqual({ attempts: 1, rows: [] })
      const mails = resetMailsTo(s, owner.email)
      expect(mails).toHaveLength(1)
      const failedToken = tokenIn(resetAttempts()[0])
      const sentToken = tokenIn(mails[0])
      expect(failedToken).not.toBe(sentToken)
      expect((await resetRowsOf(s, owner.customerId)).map((r) => r.token_hash)).toEqual([
        sha256(sentToken),
      ])
      expect(said(await reset(s, failedToken, `ac9-${randomUUID()}`))).toEqual([400, INVALID])
    })

    // Defect: at-least-once delivery doubles the mail.
    it('AC-9: an event delivered twice sends one mail and leaves one row', async () => {
      twice.on = true
      try {
        const owner = await registered(s, 'ac9-twice')

        await forgot(s, owner.email)
        await settled(s)

        expect(resetMailsTo(s, owner.email)).toHaveLength(1)
        expect((await resetRowsOf(s, owner.customerId)).map((r) => r.token_hash)).toEqual([
          sha256(tokenIn(resetMailsTo(s, owner.email)[0])),
        ])
      } finally {
        twice.on = false
      }
    })
  })

  describe(`password reset on a store with no URL (${dialect})`, () => {
    let s: PasswordStore

    beforeAll(async () => {
      s = await openPasswordStore(options.open, { storeUrl: null })
    }, 60_000)

    afterAll(async () => {
      await s?.close()
    })

    // Defect: the handler throws without a URL, and the relay retries for ever; or it mails a link to nowhere.
    it('AC-10: with store.url unset a registered address gets the same 202, no mail and no row, and one warn that names no address', async () => {
      const owner = await registered(s, 'ac10-no-url')
      await delivered(s)
      const warnsBefore = warnLines(s).length
      const logsBefore = s.logs.length

      const answer = await forgot(s, owner.email)
      await delivered(s)

      expect([answer.status, answer.body]).toEqual([202, SAME_ANSWER])
      expect(s.mail.attempts.filter((m) => m.template === RESET_MAIL)).toEqual([])
      expect(await resetRowsOf(s, owner.customerId)).toEqual([])
      expect(warnLines(s).length).toBe(warnsBefore + 1)
      expect(s.logs.slice(logsBefore).filter((line) => line.includes(owner.email))).toEqual([])
    })
  })
}
