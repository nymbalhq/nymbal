import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema } from '@nymbalhq/config'
import { renderEmailTemplate, type NymbalEvent } from '@nymbalhq/types'
import { createLogger } from '../../../src/logger.js'
import { rowsOf, subjectIds } from '../audit.js'
import { serveKernel, type ServedKernel } from '../http.js'
import { cartWith, seedVariant, type Dialect, type Kernel } from '../kernel.js'
import { adminClient } from '../money.js'
import { eventRows, maxSeq } from '../outbox.js'
import {
  call,
  delivered,
  jtiOf,
  liveRefreshOf,
  logLinesHolding,
  login,
  mailedToken,
  me,
  msOf,
  neverIssued,
  refresh,
  refreshRowsOf,
  reset,
  retried,
  said,
  settled,
  sha256,
  tablesHolding,
  warnLines,
  type Answer,
  type OpenStore,
  type PasswordStore,
} from '../password-reset.js'
import { writeRaw } from '../raw.js'
import {
  accountStateOf,
  adminOf,
  confirmed,
  customerIdOf,
  EXISTS_MAIL,
  existsMailsTo,
  expireLinks,
  headerNames,
  MAIL_HEALTH,
  newAddress,
  newPassword,
  openVerificationStore,
  register,
  registeredUnasked,
  REISSUE_MS,
  resend,
  RESEND_ANSWER,
  seeded,
  SENT,
  setCustomerCreatedAt,
  setLinkCreatedAt,
  signedUp,
  VERIFICATION_REQUESTED,
  verificationOf,
  verificationRowsOf,
  verify,
  VERIFY_INVALID,
  VERIFY_LINK,
  VERIFY_MAIL,
  VERIFY_TTL_MS,
  verifyMailsTo,
  verifyTokenIn,
} from '../verification.js'

// Sign-up with a confirmation link on one dialect, over HTTP against a kernel built from `src/`
// (tests/support/verification.ts). Under `required` a register answers 202 with one body whatever the address and signs
// nobody in; a new address gets one mail whose link carries a token only the mail holds, live for 24 hours, that
// confirms the account and signs the shopper in once; an address with an account gets an "account exists" mail at most
// once a day and its account is never written; a pending account takes the latest register's password. Races are
// forced, never timed.

export interface RegisterVerificationSuiteOptions {
  open: OpenStore
  propertyRuns: number
}

const STORE = 'https://shop.test'
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
const SPAM_WARNING =
  'Mail from this server may be rejected as spam. Add SPF and DKIM for your domain, or an email provider (`nymbal add email-resend`).'

interface SignedInBody {
  customer?: { id: string; email: string; firstName?: string; lastName?: string; phone?: string }
  accessToken?: string
}

const dataOf = <T>(a: Answer): T => a.body.data as T

/** The customer a guest cart belongs to, or null while it is a guest's. */
async function cartOwner(s: PasswordStore, token: string): Promise<string | null> {
  return (await s.k.services.cart.get(token))?.customerId ?? null
}

/** Every attempt to mail `to`, accepted or refused, by template. */
const attemptsTo = (s: PasswordStore, to: string, template?: string) =>
  s.mail.attempts.filter((m) => m.to === to && (template === undefined || m.template === template))

export function registerVerificationSuite(
  dialect: Dialect,
  options: RegisterVerificationSuiteOptions,
): void {
  describe(`register verification under required (${dialect})`, () => {
    let s: PasswordStore

    beforeAll(async () => {
      s = await openVerificationStore(options.open, { verification: 'required' })
    }, 60_000)

    afterAll(async () => {
      await s?.close()
    })

    describe('AC-2: a register answers alike for every address and writes no account it may not', () => {
      // Defect: the answer, a header or a cookie depends on the account; a register for a taken address changes a
      // confirmed, never-asked or imported account; or an after-sign-in hook runs for a register.
      it('AC-2: a new address, a confirmed account in another case, a pending account, a never-asked account and an imported customer each get 202 with one byte-equal body, the same headers, no Set-Cookie and no cart claimed; the three accounts nobody may write keep their whole row and sessions, their old password signs in where it did and the register’s does not', async () => {
        const pending = await signedUp(s, 'ac2-pending')
        const sure = await confirmed(s, 'ac2-confirmed')
        const unasked = await registeredUnasked(s, 'ac2-null')
        const importedEmail = newAddress('ac2-imported')
        const imported = await s.k.services.auth.importCustomer({ email: importedEmail })
        await delivered(s)
        const before = {
          sure: await accountStateOf(s, sure.customerId),
          unasked: await accountStateOf(s, unasked.customerId),
          imported: await accountStateOf(s, imported.id),
        }
        const guestCart = await cartWith(s.k, await seedVariant(s.k, 10), 1)
        const intruder = newPassword('ac2-intruder')
        const as = { cookies: { 'nymbal.cart': guestCart } }
        const names = { firstName: 'Mallory', lastName: 'Intruder', phone: '+447700900999' }

        const answers = [
          await register(s, { email: newAddress('ac2-new'), password: intruder, ...names }, as),
          await register(s, { email: sure.email.toUpperCase(), password: intruder, ...names }, as),
          await register(s, { email: pending.email, password: intruder, ...names }, as),
          await register(s, { email: unasked.email, password: intruder, ...names }, as),
          await register(s, { email: importedEmail, password: intruder, ...names }, as),
        ]
        await delivered(s)

        expect(answers.map((a) => a.status)).toEqual(answers.map(() => 202))
        expect(answers[0]!.body).toEqual(SENT)
        expect(
          new Set(answers.map((a) => a.text)).size,
          answers.map((a) => a.text).join(' | '),
        ).toBe(1)
        expect(answers.map((a) => a.headers.getSetCookie())).toEqual(answers.map(() => []))
        expect(answers.map(headerNames)).toEqual(answers.map(() => headerNames(answers[0]!)))
        expect(await cartOwner(s, guestCart)).toBeNull()
        expect({
          sure: await accountStateOf(s, sure.customerId),
          unasked: await accountStateOf(s, unasked.customerId),
          imported: await accountStateOf(s, imported.id),
        }).toEqual(before)
        expect([
          (await login(s, sure.email, sure.password)).status,
          (await login(s, unasked.email, unasked.password)).status,
          (await login(s, sure.email, intruder)).status,
          (await login(s, unasked.email, intruder)).status,
          (await login(s, importedEmail, intruder)).status,
        ]).toEqual([200, 200, 401, 401, 401])
      })

      // Defect: a pending account keeps the first registrant's password, so whoever registered first signs in once the
      // owner confirms.
      it('AC-2: registers with (P1, N1) then (P2, N2) for one new address, then a verify by the live link: P2 signs in, P1 is refused, and the profile reads N2; both registers answered alike', async () => {
        const email = newAddress('ac2-latest')
        const p1 = newPassword('ac2-p1')
        const p2 = newPassword('ac2-p2')
        const n1 = { firstName: 'First', lastName: 'Registrant', phone: '+447700900001' }
        const n2 = { firstName: 'Second', lastName: 'Owner', phone: '+447700900002' }

        const first = await register(s, { email, password: p1, ...n1 })
        await delivered(s)
        const second = await register(s, { email, password: p2, ...n2 })
        await delivered(s)
        const token = verifyTokenIn(verifyMailsTo(s, email).at(-1))
        const verified = await verify(s, token)
        const profile = await me(s, dataOf<SignedInBody>(verified).accessToken!)

        expect([first.status, second.status]).toEqual([202, 202])
        expect(second.text).toBe(first.text)
        expect(verified.status, verified.text).toBe(200)
        expect([(await login(s, email, p2)).status, (await login(s, email, p1)).status]).toEqual([
          200, 401,
        ])
        const read = profile.body.data as { firstName?: string; lastName?: string; phone?: string }
        expect({ firstName: read.firstName, lastName: read.lastName, phone: read.phone }).toEqual(
          n2,
        )
      })
    })

    describe('AC-4: a new address gets one link, kept only as a hash', () => {
      // Defect: the token is stored or carried in an event; the link is built without store.url; the TTL is another
      // number; or the welcome goes out to an address nobody confirmed.
      it('AC-4: a new address makes one pending customer and exactly one verify-email mail linking <store.url>/account/verify-email#token=<43 base64url chars>; the row holds the token’s SHA-256 and expires 24 hours after it was made; no welcome; the token is in no table, event or log line', async () => {
        const email = newAddress('ac4')
        const seq = await maxSeq(s.raw)

        const answer = await register(s, { email, password: newPassword('ac4') })
        await delivered(s)

        expect(answer.body).toEqual(SENT)
        const rows = await s.raw.rows<{ id: string; email_verification: unknown }>(
          'SELECT id, email_verification FROM customers WHERE email = ?',
          [email],
        )
        expect(rows.map((r) => r.email_verification)).toEqual(['pending'])
        const mails = attemptsTo(s, email)
        expect(mails.map((m) => m.template)).toEqual([VERIFY_MAIL])
        const url = String(mails[0]!.vars['verifyUrl'])
        expect(url).toMatch(VERIFY_LINK)
        const token = verifyTokenIn(mails[0])
        expect(Number(mails[0]!.vars['expiresHours'])).toBe(VERIFY_TTL_MS / HOUR_MS)
        const rendered = renderEmailTemplate(VERIFY_MAIL, mails[0]!.vars)
        expect(rendered.text.split('\n').map((line) => line.trim())).toContain(url)
        expect(rendered.subject).not.toBe(`[nymbal] ${VERIFY_MAIL}`)

        const links = await verificationRowsOf(s, rows[0]!.id)
        expect(links.map((r) => r.token_hash)).toEqual([sha256(token)])
        expect(msOf(links[0]!.expires_at) - msOf(links[0]!.created_at)).toBe(VERIFY_TTL_MS)
        const requested = (
          await eventRows(s.raw, 'seq > ? AND type = ?', [seq, VERIFICATION_REQUESTED])
        ).map((e) => (e.envelope as NymbalEvent<unknown>).payload)
        expect(requested).toEqual([{ customerId: rows[0]!.id, reissue: 'if-stale' }])
        expect(await tablesHolding(s, token)).toEqual([])
        expect(logLinesHolding(s, token)).toEqual([])
      })
    })

    describe('AC-5: a pending account cannot sign in with its password', () => {
      // Defect: an unconfirmed account signs in, or its refusal tells it apart from a wrong password; or switching on
      // an email provider locks out every account that never had a link.
      it('AC-5: a pending account’s right password gets a 401 byte-equal to a wrong password’s and writes no refresh row; a seeded account (never asked) signs in', async () => {
        const pending = await signedUp(s, 'ac5')
        const demo = await seeded(s, 'ac5-seeded')
        const wrong = await login(s, pending.email, `wrong-${randomUUID()}`)
        const sessionsBefore = await refreshRowsOf(s, pending.customerId)

        const right = await login(s, pending.email, pending.password)
        const seededAnswer = await login(s, demo.email, demo.password)

        expect([right.status, right.text]).toEqual([401, wrong.text])
        expect(await refreshRowsOf(s, pending.customerId)).toEqual(sessionsBefore)
        expect([seededAnswer.status, seededAnswer.body.data?.customer?.id]).toEqual([
          200,
          demo.customerId,
        ])
      })
    })

    describe('AC-6: the link confirms once and signs the shopper in', () => {
      // Defect: the link is reusable, does not sign in, or does not confirm.
      it('AC-6: with the mail’s token, verify-email answers 200 with a session (an access token that reads the account, a refresh cookie that refreshes, the guest cart claimed as at login); the account reads verified and its password then signs in', async () => {
        const shopper = await signedUp(s, 'ac6')
        const guestCart = await cartWith(s.k, await seedVariant(s.k, 10), 1)

        const answer = await verify(s, shopper.token, { cookies: { 'nymbal.cart': guestCart } })

        expect(answer.status, answer.text).toBe(200)
        expect(dataOf<SignedInBody>(answer).customer?.id).toBe(shopper.customerId)
        const account = await me(s, dataOf<SignedInBody>(answer).accessToken!)
        expect([account.status, (account.body.data as { id?: string } | undefined)?.id]).toEqual([
          200,
          shopper.customerId,
        ])
        expect((await refresh(s, answer.refreshCookie!)).status).toBe(200)
        expect(await cartOwner(s, guestCart)).toBe(shopper.customerId)
        expect(await verificationOf(s, shopper.customerId)).toBe('verified')
        expect((await login(s, shopper.email, shopper.password)).status).toBe(200)
      })

      // Defect: the refusals tell which tokens were real, or a refused link writes something.
      it('AC-6: the same token again, an unknown one and an expired one get byte-equal 400 auth.verify_link_invalid bodies and write nothing', async () => {
        const used = await signedUp(s, 'ac6-used')
        expect((await verify(s, used.token)).status).toBe(200)
        const late = await signedUp(s, 'ac6-expired')
        const expiredToken = neverIssued()
        await s.k.store.transaction((tx) =>
          s.k.repos.emailVerificationToken.insert(tx, {
            id: uuidv7(),
            customerId: late.customerId,
            tokenHash: sha256(expiredToken),
            expiresAt: new Date(Date.now() - 60_000),
            createdAt: new Date(Date.now() - 60_000 - VERIFY_TTL_MS),
          }),
        )
        await delivered(s)
        const before = {
          used: await accountStateOf(s, used.customerId),
          late: await accountStateOf(s, late.customerId),
          seq: await maxSeq(s.raw),
        }

        const answers = [
          await verify(s, used.token),
          await verify(s, neverIssued()),
          await verify(s, expiredToken),
        ]
        await delivered(s)

        expect(answers.map(said)).toEqual(answers.map(() => [400, VERIFY_INVALID]))
        expect(new Set(answers.map((a) => a.text)).size).toBe(1)
        expect({
          used: await accountStateOf(s, used.customerId),
          late: await accountStateOf(s, late.customerId),
          seq: await maxSeq(s.raw),
        }).toEqual(before)
      })

      // Defect: expiry is off by one or not checked.
      it('AC-6: property: at the repository, with an explicit now, findLive and consume take a row at expires_at minus 1 ms or earlier and refuse it at expires_at and after, consume then deleting nothing', async () => {
        const owner = await signedUp(s, 'ac6-repo')
        const repo = s.k.repos.emailVerificationToken
        await fc.assert(
          fc.asyncProperty(
            fc.oneof(
              fc.integer({ min: -3, max: 3 }),
              fc.integer({ min: -VERIFY_TTL_MS, max: VERIFY_TTL_MS }),
            ),
            async (offset) => {
              const token = neverIssued()
              const expiresAt = new Date(Date.now() + VERIFY_TTL_MS)
              await s.k.store.transaction((tx) =>
                repo.insert(tx, {
                  id: uuidv7(),
                  customerId: owner.customerId,
                  tokenHash: sha256(token),
                  expiresAt,
                  createdAt: new Date(expiresAt.getTime() - VERIFY_TTL_MS),
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
              const left = await s.raw.count('email_verification_tokens', 'token_hash = ?', [
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
    })

    describe('AC-7: a link is used once, however many presses race', () => {
      // Defect: single use is a read-then-delete, so a link opened twice at once makes two sessions.
      it('AC-7: property: k verifies with one token at once give exactly one 200 and k - 1 byte-equal 400s, one new refresh row (the winner’s), and a verified account', async () => {
        await fc.assert(
          fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (k) => {
            const shopper = await signedUp(s, 'ac7')
            const sessionsBefore = (await refreshRowsOf(s, shopper.customerId)).length

            const answers = await Promise.all(
              Array.from({ length: k }, () => verify(s, shopper.token)),
            )

            const winners = answers.filter((a) => a.status === 200)
            const losers = answers.filter((a) => a.status !== 200)
            expect(winners, answers.map((a) => a.text).join(' | ')).toHaveLength(1)
            expect(losers.map(said)).toEqual(losers.map(() => [400, VERIFY_INVALID]))
            expect((await refreshRowsOf(s, shopper.customerId)).length).toBe(sessionsBefore + 1)
            expect(await liveRefreshOf(s, shopper.customerId)).toEqual([
              jtiOf(winners[0]!.refreshCookie!),
            ])
            expect(await verificationOf(s, shopper.customerId)).toBe('verified')
          }),
          { numRuns: options.propertyRuns },
        )
      }, 120_000)
    })

    describe('AC-8: a pending account’s link is mailed again at most once per 15 minutes', () => {
      // Defect: every press mails, a mail bomb on any pending address.
      it('AC-8: a second register and a resend while the live link is 14 minutes old send no mail and leave the rows as they were; each answers as AC-2 and AC-10 say', async () => {
        const shopper = await signedUp(s, 'ac8-fresh')
        await setLinkCreatedAt(s, shopper.customerId, new Date(Date.now() - REISSUE_MS + 60_000))
        const rows = await verificationRowsOf(s, shopper.customerId)

        const again = await register(s, { email: shopper.email, password: newPassword('ac8') })
        const asked = await resend(s, shopper.email)
        await delivered(s)

        expect([again.body, asked.body]).toEqual([SENT, RESEND_ANSWER])
        expect(verifyMailsTo(s, shopper.email)).toHaveLength(1)
        expect(await verificationRowsOf(s, shopper.customerId)).toEqual(rows)
      })

      // Defect: a shopper whose first mail was lost waits out the link's 24 hours.
      for (const trigger of ['register', 'resend'] as const) {
        for (const age of ['15 minutes old', 'expired'] as const) {
          it(`AC-8: a ${trigger} once the live link is ${age} sends one new mail; the old token is refused and the new one verifies`, async () => {
            const shopper = await signedUp(s, `ac8-${trigger}`)
            if (age === 'expired') await expireLinks(s, shopper.customerId)
            else await setLinkCreatedAt(s, shopper.customerId, new Date(Date.now() - REISSUE_MS))

            const answer =
              trigger === 'register'
                ? await register(s, { email: shopper.email, password: shopper.password })
                : await resend(s, shopper.email)
            await delivered(s)

            expect(answer.body).toEqual(trigger === 'register' ? SENT : RESEND_ANSWER)
            const mails = verifyMailsTo(s, shopper.email)
            expect(mails).toHaveLength(2)
            const next = verifyTokenIn(mails[1])
            expect(next).not.toBe(shopper.token)
            expect(
              (await verificationRowsOf(s, shopper.customerId)).map((r) => r.token_hash),
            ).toEqual([sha256(next)])
            expect(said(await verify(s, shopper.token))).toEqual([400, VERIFY_INVALID])
            expect((await verify(s, next)).status).toBe(200)
          })
        }
      }
    })

    describe('AC-9: an existing account gets one notice a day instead of a link', () => {
      // Defect: the owner learns nothing; or an attacker mails an address once per request.
      it('AC-9: two registers each for a confirmed, a never-asked and an imported account send each exactly one account-exists mail linking <store.url>/account/login and <store.url>/account/forgot-password, each on its own line, and no verification mail or row', async () => {
        const sure = await confirmed(s, 'ac9-confirmed')
        const unasked = await registeredUnasked(s, 'ac9-null')
        const importedEmail = newAddress('ac9-imported')
        const imported = await s.k.services.auth.importCustomer({ email: importedEmail })
        await delivered(s)
        const accounts = [
          { id: sure.customerId, email: sure.email },
          { id: unasked.customerId, email: unasked.email },
          { id: imported.id, email: importedEmail },
        ]
        const verifyBefore = accounts.map((a) => verifyMailsTo(s, a.email).length)

        for (let round = 0; round < 2; round += 1) {
          for (const account of accounts) {
            await register(s, { email: account.email, password: newPassword('ac9') })
          }
        }
        await delivered(s)

        expect(accounts.map((a) => existsMailsTo(s, a.email).length)).toEqual([1, 1, 1])
        for (const account of accounts) {
          const notice = existsMailsTo(s, account.email)[0]!
          expect([notice.vars['signInUrl'], notice.vars['forgotUrl']]).toEqual([
            `${STORE}/account/login`,
            `${STORE}/account/forgot-password`,
          ])
          const lines = renderEmailTemplate(EXISTS_MAIL, notice.vars)
            .text.split('\n')
            .map((l) => l.trim())
          expect(lines).toEqual(
            expect.arrayContaining([`${STORE}/account/login`, `${STORE}/account/forgot-password`]),
          )
        }
        expect(accounts.map((a) => verifyMailsTo(s, a.email).length)).toEqual(verifyBefore)
        expect(
          await Promise.all(accounts.map(async (a) => (await verificationRowsOf(s, a.id)).length)),
        ).toEqual([0, 0, 0])
      })

      // Defect: the handler mails a placeholder address an import made up.
      it('AC-9: a register for an imported customer at a nymbal.local placeholder sends nothing to it and answers as any other', async () => {
        const placeholder = `ac9-${randomUUID().slice(0, 8)}@nymbal.local`
        await s.k.services.auth.importCustomer({ email: placeholder })
        await delivered(s)

        const answer = await register(s, { email: placeholder, password: newPassword('ac9') })
        await delivered(s)

        expect(answer.body).toEqual(SENT)
        expect(attemptsTo(s, placeholder)).toEqual([])
      })
    })

    describe('AC-10: a resend answers alike for every address', () => {
      // Defect: the resend tells which addresses are waiting.
      it('AC-10: a pending (link 15 minutes old), a confirmed, an unknown and an imported address each get 202 with one byte-equal body; only the pending one is mailed, once', async () => {
        const pending = await signedUp(s, 'ac10-pending')
        await setLinkCreatedAt(s, pending.customerId, new Date(Date.now() - REISSUE_MS))
        const sure = await confirmed(s, 'ac10-confirmed')
        const importedEmail = newAddress('ac10-imported')
        await s.k.services.auth.importCustomer({ email: importedEmail })
        await delivered(s)
        const unknown = newAddress('ac10-nobody')
        const addresses = [pending.email, sure.email, unknown, importedEmail]
        const before = addresses.map((a) => attemptsTo(s, a).length)

        const answers = []
        for (const address of addresses) answers.push(await resend(s, address))
        await delivered(s)

        expect(answers.map((a) => a.status)).toEqual([202, 202, 202, 202])
        expect(answers[0]!.body).toEqual(RESEND_ANSWER)
        expect(new Set(answers.map((a) => a.text)).size).toBe(1)
        expect(addresses.map((a, i) => attemptsTo(s, a).length - before[i]!)).toEqual([1, 0, 0, 0])
        expect(attemptsTo(s, pending.email).at(-1)?.template).toBe(VERIFY_MAIL)
      })
    })

    describe('AC-11: a password reset also confirms', () => {
      // Defect: a shopper who lost the confirmation mail must wait for it, or the reset leaves the account pending.
      it('AC-11: a pending account’s Forgot password? mails a reset; the reset signs it in, sets email_verification to verified and deletes its verification rows; its earlier link is then refused and the new password signs in', async () => {
        const shopper = await signedUp(s, 'ac11')
        const token = await mailedToken(s, shopper.email)
        const next = newPassword('ac11-new')

        const answer = await reset(s, token, next)

        expect([answer.status, answer.body.data?.customer?.id]).toEqual([200, shopper.customerId])
        expect(await verificationOf(s, shopper.customerId)).toBe('verified')
        expect(await verificationRowsOf(s, shopper.customerId)).toEqual([])
        expect(said(await verify(s, shopper.token))).toEqual([400, VERIFY_INVALID])
        expect((await login(s, shopper.email, next)).status).toBe(200)
      })

      // Defect: a reset sets a never-asked account's state, so it reads as one that was asked.
      it('AC-11: a reset of a never-asked account leaves email_verification null', async () => {
        const unasked = await registeredUnasked(s, 'ac11-null')
        const token = await mailedToken(s, unasked.email)

        const answer = await reset(s, token, newPassword('ac11-null'))

        expect(answer.status, answer.text).toBe(200)
        expect(await verificationOf(s, unasked.customerId)).toBeNull()
      })
    })

    describe('AC-12: support can send the link again or confirm the address', () => {
      // Defect: support cannot rescue a shopper whose mail is lost, or a confirmed customer is re-mailed.
      it('AC-12: send-verification on a pending customer mails a new link while a fresh one is live and the older link is then refused; on a confirmed customer it answers 409 customers.not_pending and mails nothing; on an unknown id 404 customers.not_found; each applied send writes an audit entry naming the customer', async () => {
        const admin = await adminOf(s)
        const pending = await signedUp(s, 'ac12-send')
        const sure = await confirmed(s, 'ac12-sure')
        const sureMails = attemptsTo(s, sure.email).length

        const sent = await admin.call<{ sent: boolean }>(
          'POST',
          `/api/admin/customers/${pending.customerId}/send-verification`,
        )
        await delivered(s)
        const refused = await admin.call(
          'POST',
          `/api/admin/customers/${sure.customerId}/send-verification`,
        )
        const unknown = await admin.call(
          'POST',
          `/api/admin/customers/${randomUUID()}/send-verification`,
        )
        await delivered(s)

        expect([sent.status, sent.body.data]).toEqual([202, { sent: true }])
        const mails = verifyMailsTo(s, pending.email)
        expect(mails).toHaveLength(2)
        const next = verifyTokenIn(mails[1])
        expect(next).not.toBe(pending.token)
        expect(said(await verify(s, pending.token))).toEqual([400, VERIFY_INVALID])
        expect([refused.status, refused.body.error?.code]).toEqual([409, 'customers.not_pending'])
        expect(attemptsTo(s, sure.email).length).toBe(sureMails)
        expect([unknown.status, unknown.body.error?.code]).toEqual([404, 'customers.not_found'])
        const entries = await rowsOf(s.raw, sent.headers.get('x-correlation-id'))
        expect(subjectIds(entries)).toContain(pending.customerId)
        expect((await verify(s, next)).status).toBe(200)
      })

      // Defect: the admin's confirm leaves the account pending, leaves its link usable, or the read hides the state.
      it('AC-12: mark-verified on a pending customer reads pending before and verified after, makes their password sign in and refuses their live link; a second mark-verified changes nothing and publishes nothing; it writes an audit entry naming the customer', async () => {
        const admin = await adminOf(s)
        const shopper = await signedUp(s, 'ac12-mark')
        const read = async () =>
          (
            await admin.call<{ customer: { emailVerification?: string } }>(
              'GET',
              `/api/admin/customers/${shopper.customerId}`,
            )
          ).body.data?.customer.emailVerification
        const beforeRead = await read()
        const refusedFirst = (await login(s, shopper.email, shopper.password)).status

        const marked = await admin.call<{ customer: { id: string; emailVerification?: string } }>(
          'POST',
          `/api/admin/customers/${shopper.customerId}/mark-verified`,
        )
        await delivered(s)
        const afterRead = await read()
        const signIn = (await login(s, shopper.email, shopper.password)).status
        const link = said(await verify(s, shopper.token))
        await delivered(s)
        const state = await accountStateOf(s, shopper.customerId)
        const seq = await maxSeq(s.raw)
        const again = await admin.call<{ customer: { id: string } }>(
          'POST',
          `/api/admin/customers/${shopper.customerId}/mark-verified`,
        )
        await delivered(s)

        expect([beforeRead, refusedFirst]).toEqual(['pending', 401])
        expect([
          marked.status,
          marked.body.data?.customer.id,
          marked.body.data?.customer.emailVerification,
        ]).toEqual([200, shopper.customerId, 'verified'])
        expect([afterRead, signIn, link]).toEqual(['verified', 200, [400, VERIFY_INVALID]])
        expect([again.status, again.body.data?.customer.id]).toEqual([200, shopper.customerId])
        expect({
          state: await accountStateOf(s, shopper.customerId),
          seq: await maxSeq(s.raw),
        }).toEqual({
          state,
          seq,
        })
        const entries = await rowsOf(s.raw, marked.headers.get('x-correlation-id'))
        expect(subjectIds(entries)).toContain(shopper.customerId)
      })

      // Defect: a shopper can confirm themselves, or anyone can mail any customer.
      it('AC-12: send-verification and mark-verified answer 401 with no token and 403 for a customer’s token, and leave the customer pending', async () => {
        const target = await signedUp(s, 'ac12-target')
        const customer = await confirmed(s, 'ac12-customer')
        const bearer = dataOf<SignedInBody>(
          await login(s, customer.email, customer.password),
        ).accessToken!
        const paths = [
          `/api/admin/customers/${target.customerId}/send-verification`,
          `/api/admin/customers/${target.customerId}/mark-verified`,
        ]

        const answers = []
        for (const path of paths) {
          answers.push((await call(s, 'POST', path)).status)
          answers.push((await call(s, 'POST', path, undefined, { bearer })).status)
        }
        await delivered(s)

        expect(answers).toEqual([401, 403, 401, 403])
        expect(await verificationOf(s, target.customerId)).toBe('pending')
        expect(verifyMailsTo(s, target.email)).toHaveLength(1)
      })
    })

    describe('AC-23: links die with their customer, and expired ones with the next mint', () => {
      // Defect: a removed customer's link stays usable, or dead rows are never collected.
      it('AC-23: minting a link purges the expired rows, its customer’s and another’s, leaving each live row; removing the customer deletes their rows and their link answers 400', async () => {
        const owner = await signedUp(s, 'ac23-owner')
        const other = await signedUp(s, 'ac23-other')
        const otherLive = (await verificationRowsOf(s, other.customerId)).map((r) => r.token_hash)
        for (const customerId of [owner.customerId, other.customerId]) {
          await s.k.store.transaction((tx) =>
            s.k.repos.emailVerificationToken.insert(tx, {
              id: uuidv7(),
              customerId,
              tokenHash: sha256(neverIssued()),
              expiresAt: new Date(Date.now() - 1_000),
              createdAt: new Date(Date.now() - 1_000 - VERIFY_TTL_MS),
            }),
          )
        }
        await setLinkCreatedAt(s, owner.customerId, new Date(Date.now() - REISSUE_MS))

        await resend(s, owner.email)
        await delivered(s)
        const token = verifyTokenIn(verifyMailsTo(s, owner.email).at(-1))
        const afterMint = {
          owner: (await verificationRowsOf(s, owner.customerId)).map((r) => r.token_hash),
          other: (await verificationRowsOf(s, other.customerId)).map((r) => r.token_hash),
        }
        const removed = await s.k.services.importRemoval.removeCustomer(owner.customerId)
        await delivered(s)

        expect(afterMint).toEqual({ owner: [sha256(token)], other: otherLive })
        expect(removed).toBe('removed')
        expect(await verificationRowsOf(s, owner.customerId)).toEqual([])
        expect(said(await verify(s, token))).toEqual([400, VERIFY_INVALID])
      })
    })
  })

  describe(`register verification mail delivery (${dialect})`, () => {
    let s: PasswordStore
    const twice = { on: false }

    beforeAll(async () => {
      s = await openVerificationStore(options.open, { verification: 'required', retry: true })
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
    it('AC-8: a verification send that throws leaves no live row; the relay’s retry sends exactly one mail, whose token is the live row and verifies, and the failed send’s token opens nothing', async () => {
      twice.on = false
      const email = newAddress('ac8-outage')
      s.mail.refuse.set(email, 1)

      const answer = await register(s, { email, password: newPassword('ac8-outage') })
      await settled(s)
      const customerId = await customerIdOf(s, email)
      const afterFailure = {
        attempts: attemptsTo(s, email, VERIFY_MAIL).length,
        rows: await verificationRowsOf(s, customerId),
      }
      await retried(s)

      expect(answer.body).toEqual(SENT)
      expect(afterFailure).toEqual({ attempts: 1, rows: [] })
      const mails = verifyMailsTo(s, email)
      expect(mails).toHaveLength(1)
      const failedToken = verifyTokenIn(attemptsTo(s, email, VERIFY_MAIL)[0])
      const sentToken = verifyTokenIn(mails[0])
      expect(failedToken).not.toBe(sentToken)
      expect((await verificationRowsOf(s, customerId)).map((r) => r.token_hash)).toEqual([
        sha256(sentToken),
      ])
      expect(said(await verify(s, failedToken))).toEqual([400, VERIFY_INVALID])
      expect((await verify(s, sentToken)).status).toBe(200)
    })

    // Defect: at-least-once delivery doubles the mail.
    it('AC-8: a verification event delivered twice sends one mail and leaves one row', async () => {
      twice.on = true
      try {
        const email = newAddress('ac8-twice')

        await register(s, { email, password: newPassword('ac8-twice') })
        await settled(s)

        const mails = verifyMailsTo(s, email)
        expect(mails).toHaveLength(1)
        expect(
          (await verificationRowsOf(s, await customerIdOf(s, email))).map((r) => r.token_hash),
        ).toEqual([sha256(verifyTokenIn(mails[0]))])
      } finally {
        twice.on = false
      }
    })

    // Defect: the notice is claimed before it is sent, so a provider blip loses it for the whole window.
    it('AC-9: an account-exists send that throws is retried by the relay and sends exactly one', async () => {
      twice.on = false
      // Registered through the service under no policy: its welcome goes first, so the refusal falls on the notice. A
      // delivery here waits only for what is settled: an earlier test's refused mail is still waiting out its retry.
      const unasked = { email: newAddress('ac9-outage'), password: newPassword('ac9-outage') }
      await s.k.services.auth.register(unasked)
      await settled(s)
      s.mail.refuse.set(unasked.email, 1)

      await register(s, { email: unasked.email, password: newPassword('ac9-outage') })
      await settled(s)
      const afterFailure = {
        attempts: attemptsTo(s, unasked.email, EXISTS_MAIL).length,
        sent: existsMailsTo(s, unasked.email).length,
      }
      await retried(s)

      expect(afterFailure).toEqual({ attempts: 1, sent: 0 })
      expect(existsMailsTo(s, unasked.email)).toHaveLength(1)
      expect(attemptsTo(s, unasked.email, EXISTS_MAIL)).toHaveLength(2)
    })
  })

  describe(`register verification on a store with no URL (${dialect})`, () => {
    let s: PasswordStore

    beforeAll(async () => {
      s = await openVerificationStore(options.open, { verification: 'required', storeUrl: null })
    }, 60_000)

    afterAll(async () => {
      await s?.close()
    })

    // Defect: the handler throws without a URL, and the relay retries for ever; or it mails links to nowhere.
    it('AC-9: with store.url unset, a register for an existing account answers SENT, mails nothing, and logs one warn that names no address', async () => {
      const unasked = await registeredUnasked(s, 'ac9-no-url')
      const warnsBefore = warnLines(s).length
      const logsBefore = s.logs.length

      const answer = await register(s, { email: unasked.email, password: newPassword('ac9') })
      await delivered(s)

      expect([answer.status, answer.body]).toEqual([202, SENT])
      expect(attemptsTo(s, unasked.email, EXISTS_MAIL)).toEqual([])
      expect(warnLines(s).length).toBe(warnsBefore + 1)
      expect(s.logs.slice(logsBefore).filter((line) => line.includes(unasked.email))).toEqual([])
    })
  })

  describe(`register verification under off (${dialect})`, () => {
    let s: PasswordStore

    beforeAll(async () => {
      s = await openVerificationStore(options.open, { verification: 'off' })
    }, 60_000)

    afterAll(async () => {
      await s?.close()
    })

    // Defect: the login refusal is applied whatever the policy, so a store that turns confirmation off still locks its
    // pending accounts out.
    it('AC-5: under off, an account whose row reads pending signs in with its password', async () => {
      const shopper = await registeredUnasked(s, 'ac5-off')
      await writeRaw(
        s.k.dialect,
        s.k.target,
        "UPDATE customers SET email_verification = 'pending' WHERE id = ?",
        [shopper.customerId],
      )

      const answer = await login(s, shopper.email, shopper.password)

      expect([answer.status, answer.body.data?.customer?.id]).toEqual([200, shopper.customerId])
    })

    // Defect: the resend tells which addresses have accounts on a store that does not confirm.
    it('AC-10: under off, a resend for a never-asked, an unknown and an imported address each get 202 with the one body, and nothing is mailed', async () => {
      const unasked = await registeredUnasked(s, 'ac10-off')
      const importedEmail = newAddress('ac10-off-imported')
      await s.k.services.auth.importCustomer({ email: importedEmail })
      await delivered(s)
      const addresses = [unasked.email, newAddress('ac10-off-nobody'), importedEmail]
      const before = addresses.map((a) => attemptsTo(s, a).length)

      const answers = []
      for (const address of addresses) answers.push(await resend(s, address))
      await delivered(s)

      expect(answers.map((a) => [a.status, a.body])).toEqual(
        answers.map(() => [202, RESEND_ANSWER]),
      )
      expect(new Set(answers.map((a) => a.text)).size).toBe(1)
      expect(addresses.map((a, i) => attemptsTo(s, a).length - before[i]!)).toEqual([0, 0, 0])
    })

    // Defect: the admin's funnel counts a store that never asks, so its warning fires on nothing.
    it('AC-13: under off, GET /api/admin/mail-health answers verification off and a null funnel', async () => {
      const admin = await adminOf(s)
      await registeredUnasked(s, 'ac13-off')

      const answer = await admin.call<{ verification: string; funnel: unknown }>('GET', MAIL_HEALTH)

      expect(answer.status).toBe(200)
      expect([answer.body.data?.verification, answer.body.data?.funnel]).toEqual(['off', null])
    })
  })

  describe(`mail health funnel (${dialect})`, () => {
    let s: PasswordStore

    beforeAll(async () => {
      s = await openVerificationStore(options.open, { verification: 'required' })
    }, 60_000)

    afterAll(async () => {
      await s?.close()
    })

    // Defect: the warning counts accounts never asked to confirm, counts sign-ups minutes old, or misses a store
    // whose mail is lost.
    it('AC-13: with 12 sign-ups made between 7 days and 1 hour ago (5 confirmed), 3 within the last hour, 2 older than 7 days, and seeded and off-sign-up accounts in the window, mail-health answers funnel { days: 7, started: 12, verified: 5 } and a warning naming "7 of 12"; it answers 401 with no token and 403 for a customer', async () => {
      const admin = await adminOf(s)
      const now = Date.now()
      const inWindow = []
      for (let i = 0; i < 12; i += 1) inWindow.push(await signedUp(s, `ac13-in-${i}`))
      for (const shopper of inWindow.slice(0, 5)) {
        expect((await verify(s, shopper.token)).status).toBe(200)
      }
      for (const [i, shopper] of inWindow.entries()) {
        await setCustomerCreatedAt(s, shopper.customerId, new Date(now - (2 + i * 12) * HOUR_MS))
      }
      for (let i = 0; i < 3; i += 1) await signedUp(s, `ac13-fresh-${i}`)
      const old = [await confirmed(s, 'ac13-old-confirmed'), await signedUp(s, 'ac13-old-pending')]
      for (const shopper of old)
        await setCustomerCreatedAt(s, shopper.customerId, new Date(now - 8 * DAY_MS))
      const unasked = [await seeded(s, 'ac13-seeded'), await registeredUnasked(s, 'ac13-off')]
      for (const account of unasked)
        await setCustomerCreatedAt(s, account.customerId, new Date(now - 2 * DAY_MS))
      const customer = dataOf<SignedInBody>(
        await verify(s, (await signedUp(s, 'ac13-customer')).token),
      ).accessToken!

      const answer = await admin.call<{
        verification: string
        funnel: { days: number; started: number; verified: number } | null
        warning: string | null
      }>('GET', MAIL_HEALTH)
      const anonymous = await call(s, 'GET', MAIL_HEALTH)
      const shopper = await call(s, 'GET', MAIL_HEALTH, undefined, { bearer: customer })

      expect(answer.status).toBe(200)
      const funnel = answer.body.data!.funnel!
      expect(funnel).toEqual({ days: 7, started: 12, verified: 5 })
      expect(answer.body.data?.verification).toBe('required')
      expect(answer.body.data?.warning).toContain(
        `${funnel.started - funnel.verified} of ${funnel.started}`,
      )
      expect(answer.body.data?.warning).toContain('7 of 12')
      expect([anonymous.status, shopper.status]).toEqual([401, 403])
    })
  })

  describe(`mail health on a store that sends from its own server (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel

    beforeAll(async () => {
      k = await options.open({
        configure: (config) =>
          nymbalConfigSchema.parse({
            ...config,
            store: { ...config.store, url: STORE },
            commerce: {
              ...config.commerce,
              email: {
                provider: 'smtp',
                config: {
                  from: 'Shop <orders@shop.test>',
                  smtp: { host: 'localhost', port: 2525 },
                },
              },
            },
          }),
        appOptions: {},
        logger: createLogger({ pretty: false, level: 'error' }),
      })
      served = await serveKernel(k)
    }, 60_000)

    afterAll(async () => {
      await served?.stop()
    })

    // Defect: the warning never fires for a store whose mail leaves from its own server.
    it('AC-13: an https store whose SMTP host is localhost reads the spam warning from mail-health', async () => {
      const admin = await adminClient(k, served.baseUrl)

      const answer = await admin.call<{ verification: string; warning: string | null }>('GET', MAIL_HEALTH)

      expect(answer.status).toBe(200)
      expect([answer.body.data?.verification, answer.body.data?.warning]).toEqual(['required', SPAM_WARNING])
    })
  })
}
