import { performance } from 'node:perf_hooks'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { EmailAdapter } from '@nymbalhq/types'
import { createKernel } from '../support/kernel.js'
import {
  delivered,
  forgot,
  SAME_ANSWER,
  settled,
  type Answer,
  type PasswordStore,
} from '../support/password-reset.js'
import {
  confirmed,
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
} from '../support/verification.js'

// Forgot, resend and register under `required` on SQLite, over HTTP, with a mail adapter that answers each send 300 ms
// after it is asked: the answer time of a route does not depend on the address. Five runs per class, each run a fresh
// address of its class so every class that mails does mail, compared by median with the route's baseline class.
// The adapter is slowed only for the measured requests; the setup's own mails go at once. This file slows it itself,
// so what it measures does not rest on the shared mail capture.

const SEND_MS = 300
const RUNS = 5
/** Half the send: a class whose answer includes its send is over it, whatever the machine's noise. */
const SPREAD_MS = 150

let s: PasswordStore
/** How long each send takes before the captured adapter is asked: 0 during setup, SEND_MS while measuring. */
let sendMs = 0

/** The store's mail adapter, each send answering `sendMs` after it is asked. */
function slowed(email: EmailAdapter): EmailAdapter {
  return {
    ...email,
    async sendTransactional(message) {
      if (sendMs > 0) await new Promise((resolve) => setTimeout(resolve, sendMs))
      return email.sendTransactional(message)
    },
  }
}

beforeAll(async () => {
  s = await openVerificationStore(
    (opts) => {
      const email = opts.appOptions?.adapters?.email
      if (email === undefined) throw new Error('the verification store opens with a mail adapter')
      return createKernel({
        dialect: 'sqlite',
        ...opts,
        appOptions: {
          ...opts.appOptions,
          adapters: { ...opts.appOptions?.adapters, email: slowed(email) },
        },
      })
    },
    { verification: 'required' },
  )
}, 60_000)

afterEach(async () => {
  sendMs = 0
  await settled(s)
})

afterAll(async () => {
  await s?.close()
})

interface Timed {
  ms: number
  answer: Answer
}

async function timed(request: () => Promise<Answer>): Promise<Timed> {
  const start = performance.now()
  const answer = await request()
  return { ms: performance.now() - start, answer }
}

const median = (samples: Timed[]): number => {
  const sorted = samples.map((t) => t.ms).sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

/**
 * Runs each class's request once per run, the classes interleaved so the machine's noise falls on all alike, with the
 * adapter slowed; every class's addresses are made beforehand by `setup`.
 */
async function measure(
  classes: Record<string, Array<() => Promise<Answer>>>,
): Promise<Record<string, Timed[]>> {
  const names = Object.keys(classes)
  const out: Record<string, Timed[]> = Object.fromEntries(names.map((n) => [n, []]))
  sendMs = SEND_MS
  for (let run = 0; run < RUNS; run += 1) {
    for (const name of names) out[name]!.push(await timed(classes[name]![run]!))
  }
  return out
}

function label(medians: Record<string, number>): string {
  return Object.entries(medians)
    .map(([name, ms]) => `${name} ${ms.toFixed(0)} ms`)
    .join(', ')
}

/** One address of a class per run, made one after another. */
async function runs<T>(make: (run: number) => Promise<T>): Promise<T[]> {
  const out: T[] = []
  for (let run = 0; run < RUNS; run += 1) out.push(await make(run))
  return out
}

describe('AC-7: the answer time of forgot, resend and register does not tell an address’s account', () => {
  // Defect: an answer includes the 300 ms send (known ≈ 302 ms against unknown ≈ 0 ms before the change).
  it('AC-7: forgot: with each send taking 300 ms, the median answer for a known address and for one with a live link is each within 150 ms of an unknown address’s, and every answer is 202 with the one body', async () => {
    const known = await runs((run) => seeded(s, `ac7-known-${run}`))
    const linked = await runs((run) => seeded(s, `ac7-linked-${run}`))
    for (const who of linked) expect((await forgot(s, who.email)).status).toBe(202)
    await delivered(s)

    const times = await measure({
      unknown: known.map(() => () => forgot(s, newAddress('ac7-nobody'))),
      known: known.map((who) => () => forgot(s, who.email)),
      'live link': linked.map((who) => () => forgot(s, who.email)),
    })

    const medians = Object.fromEntries(Object.entries(times).map(([n, t]) => [n, median(t)]))
    expect(medians['known']! - medians['unknown']!, label(medians)).toBeLessThan(SPREAD_MS)
    expect(medians['live link']! - medians['unknown']!, label(medians)).toBeLessThan(SPREAD_MS)
    const answers = Object.values(times).flatMap((t) => t.map((x) => x.answer))
    expect(answers.map((a) => [a.status, a.body])).toEqual(answers.map(() => [202, SAME_ANSWER]))
  }, 120_000)

  // Defect: the resend for a pending address answers after its verification mail is sent.
  it('AC-7: resend: with each send taking 300 ms, the median answer for a confirmed address and for a pending one whose link is 15 minutes old is each within 150 ms of an unknown address’s, and every answer is 202 with the one body', async () => {
    const sure = await runs((run) => confirmed(s, `ac7-confirmed-${run}`))
    const pending = await runs((run) => signedUp(s, `ac7-pending-${run}`))
    const aged = new Date(Date.now() - REISSUE_MS)
    for (const who of pending) await setLinkCreatedAt(s, who.customerId, aged)

    const times = await measure({
      unknown: sure.map(() => () => resend(s, newAddress('ac7-nobody'))),
      confirmed: sure.map((who) => () => resend(s, who.email)),
      pending: pending.map((who) => () => resend(s, who.email)),
    })

    const medians = Object.fromEntries(Object.entries(times).map(([n, t]) => [n, median(t)]))
    expect(medians['confirmed']! - medians['unknown']!, label(medians)).toBeLessThan(SPREAD_MS)
    expect(medians['pending']! - medians['unknown']!, label(medians)).toBeLessThan(SPREAD_MS)
    const answers = Object.values(times).flatMap((t) => t.map((x) => x.answer))
    expect(answers.map((a) => [a.status, a.body])).toEqual(answers.map(() => [202, RESEND_ANSWER]))
  }, 120_000)

  // Defect: one class's mail is awaited and another's is not (a new address's link deferred, the account-exists
  // notice still sent before the answer), so the time tells a taken address.
  it('AC-7: register under required: with each send taking 300 ms, the median answer for a pending address (link 15 minutes old) and for a confirmed one is each within 150 ms of a new address’s, and every answer is 202 with the one body', async () => {
    const pending = await runs((run) => signedUp(s, `ac7-reg-pending-${run}`))
    const aged = new Date(Date.now() - REISSUE_MS)
    for (const who of pending) await setLinkCreatedAt(s, who.customerId, aged)
    const sure = await runs((run) => confirmed(s, `ac7-reg-confirmed-${run}`))
    const body = (email: string) => ({ email, password: newPassword('ac7') })

    const times = await measure({
      new: pending.map(() => () => register(s, body(newAddress('ac7-new')))),
      pending: pending.map((who) => () => register(s, body(who.email))),
      confirmed: sure.map((who) => () => register(s, body(who.email))),
    })

    const medians = Object.fromEntries(Object.entries(times).map(([n, t]) => [n, median(t)]))
    expect(medians['pending']! - medians['new']!, label(medians)).toBeLessThan(SPREAD_MS)
    expect(medians['confirmed']! - medians['new']!, label(medians)).toBeLessThan(SPREAD_MS)
    const answers = Object.values(times).flatMap((t) => t.map((x) => x.answer))
    expect(answers.map((a) => [a.status, a.body])).toEqual(answers.map(() => [202, SENT]))
  }, 120_000)
})
