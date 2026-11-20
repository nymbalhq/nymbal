import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { settlesWithin } from '../../../src/tests/settles-within.js'
import type { Dialect } from '../kernel.js'
import { eventRows, maxSeq } from '../outbox.js'
import {
  forgot,
  login,
  RESET_REQUESTED,
  reset,
  resetMailsTo,
  SAME_ANSWER,
  said,
  settled,
  tokenIn,
  type Answer,
  type OpenStore,
  type PasswordStore,
} from '../password-reset.js'
import {
  confirmed,
  existsMailsTo,
  newAddress,
  newPassword,
  openVerificationStore,
  register,
  REISSUE_MS,
  resend,
  RESEND_ANSWER,
  seeded,
  SENT,
  setLinkCreatedAt,
  signedUp,
  verify,
  VERIFY_INVALID,
  verifyMailsTo,
  verifyTokenIn,
} from '../verification.js'

// The password and sign-up routes over HTTP on one dialect, with the store's mail held at a capturing adapter
// (tests/support/password-reset.ts): forgot, resend and register under `required` answer while the send they asked for
// is still held, and while another request's send holds the relay's pass; once the sends go, every address has the one
// mail it would have had and each link works once. A crash between the answer and the send loses nothing: the event
// waits in the log and the next boot sends it.

const RESET_INVALID = 'auth.reset_link_invalid'
/** A request that waits on a held send would wait for ever; this is how long each is given to answer. */
const ANSWER_BOUND_MS = 5_000

export interface MailAfterAnswerSuiteOptions {
  open: OpenStore
  /** A database of its own and an opener of kernels on it: two opened in turn are one store restarted. */
  database(): Promise<{ open: OpenStore; drop(): Promise<void> }>
}

/** The answer of a request given the bound: what it says, or `pending` when it waited on a held send. */
async function answered(request: Promise<Answer>): Promise<Answer | 'pending'> {
  const settlement = await settlesWithin(request, ANSWER_BOUND_MS)
  return settlement === 'pending' ? 'pending' : request
}

const statusOf = (a: Answer | 'pending') => (a === 'pending' ? a : a.status)

export function mailAfterAnswerSuite(dialect: Dialect, options: MailAfterAnswerSuiteOptions): void {
  describe(`answers before the mail (${dialect})`, () => {
    let s: PasswordStore

    beforeAll(async () => {
      s = await openVerificationStore(options.open, { verification: 'required' })
    }, 60_000)

    afterEach(async () => {
      // A test that failed with sends held lets them go, so the next starts with the relay idle.
      s.mail.hold.release()
      await settled(s)
    })

    afterAll(async () => {
      await s?.close()
    })

    // Defect: the answer waits on its own send, or on the pass in flight that holds another request's send; or the
    // change loses or doubles a reset mail, or a link minted for a held send no longer works.
    it('AC-6: a forgot for a known address answers 202 while its reset mail is held, and a forgot for a second known address answers while the first send is still held; after release each address has exactly one reset mail, and each link resets once', async () => {
      const first = await seeded(s, 'ac6-forgot-a')
      const second = await seeded(s, 'ac6-forgot-b')
      s.mail.hold.hold()

      const firstAnswer = await answered(forgot(s, first.email))
      expect(statusOf(firstAnswer), 'forgot for the first address').toBe(202)
      expect((firstAnswer as Answer).body).toEqual(SAME_ANSWER)
      expect(resetMailsTo(s, first.email), 'reset mails to the first at its answer').toEqual([])
      expect(
        await settlesWithin(s.mail.hold.waiting(1), ANSWER_BOUND_MS),
        'the first reset send, reaching the adapter',
      ).toBe('resolved')

      const secondAnswer = await answered(forgot(s, second.email))
      expect(statusOf(secondAnswer), 'forgot for the second address, the first send held').toBe(202)
      expect((secondAnswer as Answer).body).toEqual(SAME_ANSWER)
      expect(
        s.mail.held.map((m) => m.to),
        'sends held at the second answer',
      ).toEqual([first.email])

      s.mail.hold.release()
      await settled(s)

      const addresses = [first, second]
      expect(addresses.map((a) => resetMailsTo(s, a.email).length)).toEqual(addresses.map(() => 1))
      for (const a of addresses) {
        const token = tokenIn(resetMailsTo(s, a.email)[0])
        const chosen = newPassword('ac6-reset')
        expect((await reset(s, token, chosen)).status, `reset for ${a.email}`).toBe(200)
        expect(said(await reset(s, token, newPassword('ac6-again')))).toEqual([400, RESET_INVALID])
        expect((await login(s, a.email, chosen)).status, `sign-in for ${a.email}`).toBe(200)
      }
    })

    // Defect: the resend answers only once its verification mail is sent; or the link that mail carries is lost.
    it('AC-6: a resend for a pending address whose link is 15 minutes old answers 202 while its mail is held; after release the address has exactly one new verify mail, whose link verifies once', async () => {
      const pending = await signedUp(s, 'ac6-resend')
      await setLinkCreatedAt(s, pending.customerId, new Date(Date.now() - REISSUE_MS))
      const before = verifyMailsTo(s, pending.email).length
      s.mail.hold.hold()

      const answer = await answered(resend(s, pending.email))

      expect(statusOf(answer), 'resend for the pending address').toBe(202)
      expect((answer as Answer).body).toEqual(RESEND_ANSWER)
      expect(verifyMailsTo(s, pending.email).length, 'verify mails at the answer').toBe(before)

      s.mail.hold.release()
      await settled(s)

      const mails = verifyMailsTo(s, pending.email)
      expect(mails.length, 'verify mails after the release').toBe(before + 1)
      const token = verifyTokenIn(mails.at(-1))
      expect(token).not.toBe(pending.token)
      expect((await verify(s, token)).status).toBe(200)
      expect(said(await verify(s, token))).toEqual([400, VERIFY_INVALID])
    })

    // Defect: a register answers only once its mail (a link, or the account-exists notice) is sent, so the time tells
    // which addresses have accounts; or the change loses or doubles one of those mails.
    it('AC-6: under required, a register for a new, a pending (link 15 minutes old) and a confirmed address each answer 202 while the mails are held; after release the new and the pending address each have one more verify mail, the confirmed one one account-exists mail, and each new link verifies once', async () => {
      const fresh = newAddress('ac6-new')
      const pending = await signedUp(s, 'ac6-pending')
      await setLinkCreatedAt(s, pending.customerId, new Date(Date.now() - REISSUE_MS))
      const sure = await confirmed(s, 'ac6-confirmed')
      const mailsOf = () => ({
        fresh: verifyMailsTo(s, fresh).length,
        pending: verifyMailsTo(s, pending.email).length,
        exists: existsMailsTo(s, sure.email).length,
      })
      const before = mailsOf()
      s.mail.hold.hold()

      const answers: Array<Answer | 'pending'> = []
      for (const email of [fresh, pending.email, sure.email]) {
        answers.push(await answered(register(s, { email, password: newPassword('ac6-register') })))
      }

      expect(answers.map(statusOf), 'register: new, pending, confirmed').toEqual([202, 202, 202])
      expect(answers.map((a) => (a as Answer).body)).toEqual([SENT, SENT, SENT])
      expect(mailsOf(), 'mails at the answers').toEqual(before)

      s.mail.hold.release()
      await settled(s)

      expect(mailsOf()).toEqual({
        fresh: before.fresh + 1,
        pending: before.pending + 1,
        exists: before.exists + 1,
      })
      for (const email of [fresh, pending.email]) {
        const token = verifyTokenIn(verifyMailsTo(s, email).at(-1))
        expect((await verify(s, token)).status, `verify for ${email}`).toBe(200)
        expect(said(await verify(s, token))).toEqual([400, VERIFY_INVALID])
      }
    })
  })

  describe(`a crash between the answer and the mail (${dialect})`, () => {
    // Defect: the deferred delivery lives only in memory (an event marked delivered before its handlers ran, or
    // delivery not from the log), so a crash between the answer and the send loses the link.
    it('AC-8: with the relay stopped before the request, a forgot for a known address answers 202, its event stays undelivered and nothing is mailed; a new kernel on the same database sends exactly one reset mail at boot, and its link resets the password', async () => {
      const db = await options.database()
      let crashed: PasswordStore | undefined
      let restarted: PasswordStore | undefined
      try {
        crashed = await openVerificationStore(db.open, { verification: 'required' })
        const who = await seeded(crashed, 'ac8-crash')
        const from = await maxSeq(crashed.raw)
        // A crash leaves no pass: nothing hands the log to the bus from here on.
        await crashed.k.app.relay.stop()

        const answer = await forgot(crashed, who.email)

        expect([answer.status, answer.body]).toEqual([202, SAME_ANSWER])
        const rows = await eventRows(crashed.raw, 'seq > ? AND type = ?', [from, RESET_REQUESTED])
        expect(
          rows.map((r) => r.deliveredAt ?? null),
          'the reset request in the log',
        ).toEqual([null])
        expect(crashed.mail.attempts.filter((m) => m.to === who.email)).toEqual([])
        await crashed.close()
        crashed = undefined

        restarted = await openVerificationStore(db.open, { verification: 'required' })

        const mails = resetMailsTo(restarted, who.email)
        expect(mails.length, 'reset mails sent by the boot').toBe(1)
        const chosen = newPassword('ac8-reset')
        expect((await reset(restarted, tokenIn(mails[0]), chosen)).status).toBe(200)
        expect((await login(restarted, who.email, chosen)).status).toBe(200)
        expect(said(await login(restarted, who.email, who.password))[0]).toBe(401)
      } finally {
        await crashed?.close()
        await restarted?.close()
        await db.drop()
      }
    })
  })
}
