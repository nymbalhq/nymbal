import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import type { NymbalEvent, TransactionalEmail } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../http.js'
import { postDelivery, recordsFor, type Delivered } from '../inbound-webhooks.js'
import { checkoutOf, seedVariant, type Kernel } from '../kernel.js'
import { eventRows, maxSeq, placeholders, type EventRow } from '../outbox.js'
import { openRaw, type RawReader } from '../raw.js'
import { primedShopper } from '../security.js'
import {
  BOUNCED,
  COMPLAINED,
  complaint,
  createTestMailAdapter,
  deliveryOf,
  formDelivery,
  hardBounce,
  jsonDelivery,
  softBounce,
  TEST_MAIL,
  textDelivery,
  type Encoding,
  type ProviderEvent,
  type SignedDelivery,
  type TestMailAdapter,
} from '../test-mail.js'

// Bounces and complaints from the store's email provider (`test-mail`, a custom email adapter that also captures every
// send) on one dialect, through the served kernel's real webhook route: what reaches the log, what is refused whole,
// who is suppressed, and what a suppressed address is no longer mailed. Rows and events are read through a second
// connection.

export interface OpenEmailFeedbackKernel {
  configure: (config: NymbalConfig) => NymbalConfig
  appOptions: { adapters: { email: TestMailAdapter } }
}

export interface EmailFeedbackSuiteOptions {
  /** A kernel on a database of its own, migrated to the newest migration. */
  open(opts: OpenEmailFeedbackKernel): Promise<Kernel>
  propertyRuns: number
}

const HANDLER = `webhook:${TEST_MAIL}`
const SHOP = 'http://shop-a.test'
const SUBSCRIBE = '/api/alerts/subscribe'
const CONFIRM = '/api/alerts/confirm'
const SUPPRESSIONS = 'email_suppressions'
const INVALID_MEDIA_TYPE = 'FST_ERR_CTP_INVALID_MEDIA_TYPE'

type AlertKind = 'back_in_stock' | 'price_drop'
const CONFIRM_MAIL: Record<AlertKind, string> = {
  back_in_stock: 'alert-confirm',
  price_drop: 'alert-confirm-price-drop',
}
const ALERT_MAIL: Record<AlertKind, string> = {
  back_in_stock: 'alert-back-in-stock',
  price_drop: 'alert-price-drop',
}
const ALERT_KINDS: AlertKind[] = ['back_in_stock', 'price_drop']

function storeConfig(config: NymbalConfig): NymbalConfig {
  return {
    ...config,
    commerce: { ...config.commerce, email: { provider: 'custom' } },
    http: { ...config.http, cors: { ...config.http.cors, allowedOrigins: [SHOP] } },
    security: {
      ...config.security,
      rateLimit: {
        ...config.security.rateLimit,
        [SUBSCRIBE]: { requests: 100_000, window: '1m', action: 'block' },
      },
    },
  } as NymbalConfig
}

const norm = (email: string): string => email.trim().toLowerCase()
const freshEmail = (role: string): string => `${role}-${randomUUID()}@feedback.test`
const freshId = (): string => `dlv_${randomUUID()}`

/** An address as a provider may report it: the same mailbox in other case, with spaces around it. */
type Form = { left: number; right: number; upper: boolean }
const arbForm: fc.Arbitrary<Form> = fc.record({
  left: fc.integer({ min: 0, max: 2 }),
  right: fc.integer({ min: 0, max: 2 }),
  upper: fc.boolean(),
})
const vary = (email: string, f: Form): string =>
  `${' '.repeat(f.left)}${f.upper ? email.toUpperCase() : email}${' '.repeat(f.right)}`

const arbEncoding: fc.Arbitrary<Encoding> = fc.constantFrom('json', 'form', 'text')

interface SuppressionRow {
  email: string
  reason: string
  event_id: string
}

function tally(answers: Delivered[]) {
  return {
    received: answers.filter((a) => a.status === 200 && a.data?.received === true).length,
    deduped: answers.filter((a) => a.status === 200 && a.data?.deduped === true).length,
  }
}

export function emailFeedbackSuite(dialect: Kernel['dialect'], options: EmailFeedbackSuiteOptions) {
  describe(`email bounce and complaint webhooks (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader
    let base = ''
    let csrf: Record<string, string> = {}
    const mail = createTestMailAdapter()
    /** While on, the bus hands every event to its subscribers twice (at-least-once delivery). */
    const twice = { on: false }

    beforeAll(async () => {
      k = await options.open({ configure: storeConfig, appOptions: { adapters: { email: mail } } })
      const bus = k.eventBus
      const publish = bus.publish.bind(bus)
      bus.publish = async function <T>(event: NymbalEvent<T>): Promise<void> {
        await publish(event)
        if (twice.on) await publish(event)
      }
      served = await serveKernel(k)
      base = served.baseUrl
      const shop = await primedShopper(base)
      const token = shop.jar.get('nymbal.csrf')!
      csrf = { cookie: `nymbal.csrf=${token}`, 'x-csrf-token': token }
      raw = openRaw(k.dialect, k.target)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    // ─── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────

    const send = (delivery: SignedDelivery): Promise<Delivered> =>
      postDelivery(base, TEST_MAIL, delivery)

    async function counts() {
      return { events: await raw.count('events'), records: await raw.count('processed_events') }
    }

    /** The suppression rows of these addresses, by normalised address. */
    async function suppressionsOf(emails: string[]): Promise<SuppressionRow[]> {
      const keys = [...new Set(emails.map(norm))]
      if (keys.length === 0) return []
      const rows = await raw.rows<SuppressionRow>(
        `SELECT email, reason, event_id FROM ${SUPPRESSIONS} WHERE email IN (${placeholders(keys.length)})`,
        keys,
      )
      return [...rows].sort((a, b) => a.email.localeCompare(b.email))
    }

    /** Every event appended has been handed to the bus (or given up on), so every send that will happen has. */
    async function delivered(): Promise<void> {
      await vi.waitFor(
        async () => {
          const open = (await eventRows(raw)).filter(
            (r) => r.deliveredAt == null && r.deadAt == null,
          )
          expect(open.map((r) => r.type)).toEqual([])
        },
        { timeout: 10_000, interval: 20 },
      )
    }

    /** The feedback events of `type` appended since `afterSeq`, in order. */
    async function feedbackSince(afterSeq: number, type: string): Promise<EventRow[]> {
      return eventRows(raw, 'seq > ? AND type = ?', [afterSeq, type])
    }

    /** Events since `afterSeq` that were retried or given up on: [type, attempts, dead]. */
    async function retriedSince(afterSeq: number): Promise<unknown[]> {
      return (await eventRows(raw, 'seq > ?', [afterSeq]))
        .filter((r) => r.attempts > 0 || r.deadAt != null)
        .map((r) => [r.type, r.attempts, r.deadAt != null])
    }

    async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
      const res = await fetch(new URL(path, base), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      let parsed: { data?: Record<string, unknown>; error?: { code: string } } = {}
      try {
        parsed = text === '' ? {} : JSON.parse(text)
      } catch {
        // the status says what happened
      }
      return { status: res.status, text, body: parsed }
    }

    const subscribe = (email: string, variantId: string, kind: AlertKind) =>
      post(SUBSCRIBE, { email, variantId, kind }, { ...csrf, origin: SHOP })

    const confirm = (token: string) => post(CONFIRM, { token })

    const mailsTo = (email: string, template?: string): TransactionalEmail[] =>
      mail.sent.filter(
        (m) => m.to === norm(email) && (template === undefined || m.template === template),
      )

    function tokenOf(m: TransactionalEmail): string {
      return new URL(String(m.vars['confirmUrl'])).searchParams.get('token') ?? ''
    }

    async function seedProduct(stock: number, priceMinor: number) {
      const tag = randomUUID().slice(0, 8)
      const product = await k.services.product.create({
        slug: `feedback-${tag}`,
        name: `Feedback Widget ${tag}`,
        description: '',
        status: 'active',
        variants: [
          {
            sku: `FEEDBACK-${tag}`,
            name: 'Default',
            priceMinor,
            stock,
            lowStockThreshold: 0,
            options: [],
          },
        ],
      })
      return { productId: product.id, variantId: product.variants[0]!.id }
    }

    // ─── AC-2, AC-3: what the route takes ────────────────────────────────────────────────────────────────────

    it(`AC-2: on the store, form-encoded, octet-stream and untyped bodies to /api/alerts/subscribe answer 415 ${INVALID_MEDIA_TYPE} and write no subscription, while a signed form-encoded bounce to /api/webhooks/test-mail is received (${dialect})`, async () => {
      const p = await seedProduct(0, 1000)
      const email = freshEmail('ac2')
      const form = new URLSearchParams({ email, variantId: p.variantId, kind: 'back_in_stock' })
      const bodies: Array<[Buffer, string | null]> = [
        [Buffer.from(form.toString()), 'application/x-www-form-urlencoded'],
        [Buffer.from(form.toString()), 'application/octet-stream'],
        [Buffer.from(form.toString()), null],
      ]

      const answers = await Promise.all(
        bodies.map(async ([bytes, type]) => {
          const res = await fetch(new URL(SUBSCRIBE, base), {
            method: 'POST',
            headers: { ...csrf, origin: SHOP, ...(type === null ? {} : { 'content-type': type }) },
            body: new Uint8Array(bytes),
          })
          return { status: res.status, text: await res.text() }
        }),
      )

      expect(answers.map((a) => a.status)).toEqual(bodies.map(() => 415))
      expect(answers.filter((a) => !a.text.includes(INVALID_MEDIA_TYPE))).toEqual([])
      expect(await raw.count('alert_subscriptions', 'email = ?', [norm(email)])).toBe(0)

      const bounce = await send(formDelivery(freshId(), hardBounce(freshEmail('ac2-bounce'))))
      expect([bounce.status, bounce.data], JSON.stringify(bounce.body)).toEqual([
        200,
        { received: true, events: 1 },
      ])
    })

    it(`AC-3: a signed form-encoded hard bounce and a signed text/plain complaint each answer 200 { received: true, events: 1 }, put their event in the log under source webhook:test-mail and record (webhook:test-mail, deliveryId) (${dialect})`, async () => {
      const cases = [
        { id: freshId(), recipient: freshEmail('form'), type: BOUNCED, encode: formDelivery },
        { id: freshId(), recipient: freshEmail('text'), type: COMPLAINED, encode: textDelivery },
      ]
      for (const c of cases) {
        const seq = await maxSeq(raw)
        const event = c.type === BOUNCED ? hardBounce(c.recipient) : complaint(c.recipient)

        const answer = await send(c.encode(c.id, event))

        expect([answer.status, answer.data], `${c.type}: ${JSON.stringify(answer.body)}`).toEqual([
          200,
          { received: true, events: 1 },
        ])
        const rows = await feedbackSince(seq, c.type)
        expect(
          rows.map((r) => [
            r.envelope.source,
            (r.envelope.payload as { recipient?: unknown }).recipient,
          ]),
        ).toEqual([[HANDLER, c.recipient]])
        expect(await recordsFor(raw, HANDLER, c.id)).toBe(1)
      }
    })

    // ─── AC-4: refused whole ─────────────────────────────────────────────────────────────────────────────────

    /** A valid provider event for a fresh recipient. */
    const validEvent: fc.Arbitrary<ProviderEvent> = fc
      .constantFrom('hard', 'soft', 'complaint')
      .map((what) => {
        const to = freshEmail(`ok-${what}`)
        return what === 'hard' ? hardBounce(to) : what === 'soft' ? softBounce(to) : complaint(to)
      })

    const unreadableDate = fc
      .constantFrom('not a date', '', 'yesterday', '2026-13-45T99:99:99Z', 'Z')
      .filter((s) => Number.isNaN(Date.parse(s)))

    /** One way to break the feedback rule; `jsonOnly` when the break cannot be said in a form or text body. */
    const BREAKS: Record<string, { event: fc.Arbitrary<ProviderEvent>; jsonOnly: boolean }> = {
      'no recipient': {
        event: fc.constant(null).map(() => {
          const { recipient: _r, ...rest } = hardBounce('x@feedback.test')
          return rest as ProviderEvent
        }),
        jsonOnly: false,
      },
      'an empty or whitespace-only recipient': {
        event: fc
          .constantFrom('', ' ', '  ', '\t', ' \n ')
          .map((recipient) => ({ ...hardBounce('x@feedback.test'), recipient })),
        jsonOnly: false,
      },
      "bounce: 'permanent'": {
        event: fc
          .constantFrom('permanent', 'transient', 'Hard', 'undetermined')
          .map((bounce) => ({ ...hardBounce(freshEmail('perm')), bounce })),
        jsonOnly: false,
      },
      'a non-string messageId': {
        event: fc
          .oneof(
            fc.integer(),
            fc.boolean(),
            fc.constant({}),
            fc.array(fc.string(), { maxLength: 2 }),
          )
          .map((message_id) => ({ ...hardBounce(freshEmail('mid')), message_id })),
        jsonOnly: true,
      },
      'an unreadable occurredAt': {
        event: unreadableDate.map((occurred_at) => ({
          ...hardBounce(freshEmail('date')),
          occurred_at,
        })),
        jsonOnly: false,
      },
      'a complaint with no recipient': {
        event: fc.constant(null).map(() => {
          const { recipient: _r, ...rest } = complaint('x@feedback.test')
          return rest as ProviderEvent
        }),
        jsonOnly: false,
      },
    }

    it(`AC-4: property: a delivery holding a bounce or complaint that breaks the feedback rule (no recipient, an empty or whitespace recipient, an unknown bounce, a non-string messageId, an unreadable occurredAt, a complaint with no recipient), after valid events or alone, answers 500 webhook.event_invalid, leaves the events and processed_events counts unchanged and suppresses no recipient; the same delivery fixed and re-signed under its id is then received (${dialect})`, async () => {
      for (const [kind, brk] of Object.entries(BREAKS)) {
        await fc.assert(
          fc.asyncProperty(
            fc.array(validEvent, { maxLength: 2 }),
            brk.event,
            arbEncoding,
            async (head, broken, encoding) => {
              const id = freshId()
              const alone = head.length === 0 && !brk.jsonOnly
              const delivery = alone
                ? deliveryOf(encoding, id, broken)
                : jsonDelivery({ id, events: [...head, broken] })
              const before = await counts()

              const answer = await send(delivery)

              const seen = `${kind} (${alone ? encoding : 'json'}): ${JSON.stringify(broken)} → ${answer.status} ${JSON.stringify(answer.body)}`
              expect([answer.status, answer.error?.code], seen).toEqual([
                500,
                'webhook.event_invalid',
              ])
              expect(await counts(), seen).toEqual(before)
              await delivered()
              const recipients = [...head, broken]
                .map((e) => e.recipient)
                .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
              expect(await suppressionsOf(recipients), seen).toEqual([])

              const fixedEvent = hardBounce(freshEmail('fixed'))
              const fixed = alone
                ? deliveryOf(encoding, id, fixedEvent)
                : jsonDelivery({ id, events: [...head, fixedEvent] })
              const retry = await send(fixed)
              expect([retry.status, retry.data], seen).toEqual([
                200,
                { received: true, events: head.length + 1 },
              ])
              expect(await recordsFor(raw, HANDLER, id)).toBe(1)
              await delivered()
            },
          ),
          { numRuns: 2 },
        )
      }
    }, 120_000)

    // ─── AC-5: who is suppressed ─────────────────────────────────────────────────────────────────────────────

    it(`AC-5: property: over hard bounces, soft bounces and complaints for a few recipients in case and whitespace variants, every event delivered twice, email_suppressions holds exactly one row per normalised recipient that had a hard bounce or a complaint, with the first reason and the id of the event that gave it; a recipient with only soft bounces has none; no feedback event is retried (${dialect})`, async () => {
      const PEOPLE = 3
      const arbOp = fc.record({
        who: fc.integer({ min: 0, max: PEOPLE - 1 }),
        what: fc.constantFrom('hard' as const, 'soft' as const, 'complaint' as const),
        form: arbForm,
        encoding: arbEncoding,
      })
      twice.on = true
      try {
        await fc.assert(
          fc.asyncProperty(fc.array(arbOp, { minLength: 1, maxLength: 10 }), async (ops) => {
            const people = Array.from({ length: PEOPLE }, (_, i) => freshEmail(`p${i}`))
            const start = await maxSeq(raw)
            /** Normalised address → the first suppressing reason and its event's id. */
            const expected = new Map<string, { reason: string; event_id: string }>()

            for (const op of ops) {
              const to = vary(people[op.who]!, op.form)
              const event =
                op.what === 'hard'
                  ? hardBounce(to)
                  : op.what === 'soft'
                    ? softBounce(to)
                    : complaint(to)
              const seq = await maxSeq(raw)
              const answer = await send(deliveryOf(op.encoding, freshId(), event))
              expect([answer.status, answer.data], JSON.stringify(op)).toEqual([
                200,
                { received: true, events: 1 },
              ])
              const rows = await feedbackSince(seq, op.what === 'complaint' ? COMPLAINED : BOUNCED)
              expect(rows.length, JSON.stringify(op)).toBe(1)
              const key = norm(people[op.who]!)
              if (op.what !== 'soft' && !expected.has(key)) {
                expected.set(key, {
                  reason: op.what === 'hard' ? 'hard_bounce' : 'complaint',
                  event_id: rows[0]!.id,
                })
              }
            }
            await delivered()

            expect(await suppressionsOf(people), JSON.stringify(ops)).toEqual(
              [...expected.entries()]
                .map(([email, v]) => ({ email, ...v }))
                .sort((a, b) => a.email.localeCompare(b.email)),
            )
            expect(await retriedSince(start), JSON.stringify(ops)).toEqual([])
          }),
          { numRuns: options.propertyRuns },
        )
      } finally {
        twice.on = false
      }
    }, 180_000)

    // ─── AC-7: a replay is recorded once ─────────────────────────────────────────────────────────────────────

    for (const concurrent of dialect === 'postgres' ? [false, true] : [false]) {
      const how = concurrent ? 'all at once' : 'one after another'

      it(`AC-7: property: one signed hard-bounce delivery sent k times (2-5), ${how}, leaves one processed_events row, one test-mail.bounced.v1 and one suppression row; one answer is received and the rest deduped (${dialect})`, async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 2, max: 5 }),
            arbEncoding,
            arbForm,
            async (times, encoding, form) => {
              const recipient = freshEmail('replay')
              const id = freshId()
              const delivery = deliveryOf(encoding, id, hardBounce(vary(recipient, form)))
              const seq = await maxSeq(raw)

              const answers = concurrent
                ? await Promise.all(Array.from({ length: times }, () => send(delivery)))
                : await (async () => {
                    const out: Delivered[] = []
                    for (let i = 0; i < times; i += 1) out.push(await send(delivery))
                    return out
                  })()
              await delivered()

              const seen = answers.map((a) => `${a.status} ${JSON.stringify(a.body)}`).join('\n')
              expect(tally(answers), seen).toEqual({ received: 1, deduped: times - 1 })
              expect(await recordsFor(raw, HANDLER, id)).toBe(1)
              expect((await feedbackSince(seq, BOUNCED)).length).toBe(1)
              expect((await suppressionsOf([recipient])).map((r) => [r.email, r.reason])).toEqual([
                [norm(recipient), 'hard_bounce'],
              ])
            },
          ),
          { numRuns: 4 },
        )
      }, 120_000)
    }

    it(`AC-7: two different deliveries bouncing one address give two events and one suppression row, naming the first (${dialect})`, async () => {
      const recipient = freshEmail('twice')
      const seq = await maxSeq(raw)

      const answers = [
        await send(jsonDelivery({ id: freshId(), events: [hardBounce(recipient)] })),
        await send(formDelivery(freshId(), hardBounce(` ${recipient.toUpperCase()}`))),
      ]
      await delivered()

      expect(answers.map((a) => a.data)).toEqual(answers.map(() => ({ received: true, events: 1 })))
      const events = await feedbackSince(seq, BOUNCED)
      expect(events.length).toBe(answers.length)
      expect(await suppressionsOf([recipient])).toEqual([
        { email: norm(recipient), reason: 'hard_bounce', event_id: events[0]!.id },
      ])
    })

    // ─── AC-6: a bounced address gets no further alert mail ──────────────────────────────────────────────────

    type Op =
      | { kind: 'subscribe'; who: number; alert: AlertKind }
      | { kind: 'confirm'; who: number; alert: AlertKind }
      | { kind: 'restock' }
      | { kind: 'sellout' }
      | { kind: 'price'; move: 'up' | 'down'; step: number }
      | { kind: 'soft' }
      | { kind: 'feedback'; what: 'hard' | 'complaint' }

    type State = 'none' | 'pending' | 'active' | 'fired'
    interface ModelRow {
      state: State
      /** Whether the row's current confirmation token has been mailed. */
      tokenMailed: boolean
      baseline: number | null
      confirmations: number
      alerts: number
    }

    const arbWho = fc.integer({ min: 0, max: 1 })
    const arbAlert = fc.constantFrom<AlertKind>(...ALERT_KINDS)
    const arbOp: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ kind: fc.constant('subscribe' as const), who: arbWho, alert: arbAlert }),
      fc.record({ kind: fc.constant('subscribe' as const), who: arbWho, alert: arbAlert }),
      fc.record({ kind: fc.constant('confirm' as const), who: arbWho, alert: arbAlert }),
      fc.record({ kind: fc.constant('confirm' as const), who: arbWho, alert: arbAlert }),
      fc.constant({ kind: 'restock' as const }),
      fc.constant({ kind: 'sellout' as const }),
      fc.record({
        kind: fc.constant('price' as const),
        move: fc.constantFrom('up' as const, 'down' as const),
        step: fc.integer({ min: 1, max: 300 }),
      }),
      fc.constant({ kind: 'soft' as const }),
    )
    /** A run's operations with one hard bounce or complaint for A at a generated point. */
    const arbRun = fc
      .tuple(
        fc.array(arbOp, { minLength: 2, maxLength: 10 }),
        fc.nat(),
        fc.constantFrom('hard' as const, 'complaint' as const),
      )
      .map(([ops, at, what]) => {
        const i = at % (ops.length + 1)
        return [...ops.slice(0, i), { kind: 'feedback' as const, what }, ...ops.slice(i)]
      })

    it(`AC-6: property: over generated subscribes, confirms, restocks and price moves for A and B with a hard bounce or a complaint for A at a generated point and soft bounces for A anywhere, the confirmations and alerts each gets equal the model: A none once suppressed, B exactly as before; every row keeps the model's status and baseline, alert.sent.v1 counts follow the alerts sent, no event is retried, and A's subscribe then answers the same bytes as a fresh address's (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(arbRun, async (ops) => {
          const START_PRICE = 2000
          const p = await seedProduct(0, START_PRICE)
          const people = [freshEmail('a'), freshEmail('b')]
          const start = await maxSeq(raw)
          let stock = 0
          let price = START_PRICE
          let suppressedA = false
          const model = people.map(
            () =>
              Object.fromEntries(
                ALERT_KINDS.map((kind) => [
                  kind,
                  {
                    state: 'none',
                    tokenMailed: false,
                    baseline: null,
                    confirmations: 0,
                    alerts: 0,
                  },
                ]),
              ) as Record<AlertKind, ModelRow>,
          )
          const suppressed = (who: number) => who === 0 && suppressedA

          const subscribeModel = (who: number, alert: AlertKind) => {
            const row = model[who]![alert]
            if (row.state === 'active') return
            if (row.state === 'none' || row.state === 'fired') {
              row.tokenMailed = false
              if (alert === 'price_drop' && row.state === 'none') row.baseline = price
            }
            row.state = 'pending'
            if (!suppressed(who)) {
              row.confirmations += 1
              row.tokenMailed = true
            }
          }

          async function apply(op: Op): Promise<void> {
            const label = JSON.stringify(op)
            if (op.kind === 'subscribe') {
              const res = await subscribe(people[op.who]!, p.variantId, op.alert)
              expect(res.status, `${label}: ${res.text.slice(0, 200)}`).toBe(202)
              subscribeModel(op.who, op.alert)
            } else if (op.kind === 'confirm') {
              const last = mailsTo(people[op.who]!, CONFIRM_MAIL[op.alert]).at(-1)
              if (last === undefined) return
              const row = model[op.who]![op.alert]
              const res = await confirm(tokenOf(last))
              const accepted =
                (row.state === 'pending' || row.state === 'active') && row.tokenMailed
              expect(
                [res.status, res.body.data?.['status'] ?? res.body.error?.code],
                label,
              ).toEqual(accepted ? [200, 'active'] : [404, 'alerts.link_invalid'])
              if (accepted) row.state = 'active'
            } else if (op.kind === 'restock') {
              if (stock === 0) {
                model.forEach((rows, who) => {
                  const row = rows.back_in_stock
                  if (row.state !== 'active' || suppressed(who)) return
                  row.alerts += 1
                  row.state = 'fired'
                })
              }
              await k.services.inventory.adjustStock(p.variantId, 1, 'manual', 'feedback-suite')
              stock += 1
            } else if (op.kind === 'sellout') {
              if (stock > 0) {
                await k.services.inventory.adjustStock(
                  p.variantId,
                  -stock,
                  'manual',
                  'feedback-suite',
                )
                stock = 0
              }
            } else if (op.kind === 'price') {
              const next = op.move === 'up' ? price + op.step : Math.max(1, price - op.step)
              if (next === price) return
              if (next < price) {
                model.forEach((rows, who) => {
                  const row = rows.price_drop
                  if (row.state !== 'active' || row.baseline === null || suppressed(who)) return
                  if (next < row.baseline) {
                    row.alerts += 1
                    row.baseline = next
                  }
                })
              }
              await k.services.product.update(p.productId, {
                variants: [{ id: p.variantId, priceMinor: next }],
              })
              price = next
            } else if (op.kind === 'soft') {
              const answer = await send(
                jsonDelivery({ id: freshId(), events: [softBounce(people[0]!)] }),
              )
              expect(answer.data, label).toEqual({ received: true, events: 1 })
            } else {
              const event =
                op.what === 'hard' ? hardBounce(people[0]!.toUpperCase()) : complaint(people[0]!)
              const answer = await send(jsonDelivery({ id: freshId(), events: [event] }))
              expect(answer.data, label).toEqual({ received: true, events: 1 })
              suppressedA = true
            }
          }

          async function check(label: string): Promise<void> {
            const got = people.map((email) =>
              ALERT_KINDS.flatMap((alert) => [
                mailsTo(email, CONFIRM_MAIL[alert]).length,
                mailsTo(email, ALERT_MAIL[alert]).length,
              ]),
            )
            const want = model.map((rows) =>
              ALERT_KINDS.flatMap((alert) => [rows[alert].confirmations, rows[alert].alerts]),
            )
            expect(
              got,
              `${label}: [confirm, alert] × [back in stock, price drop] for A, B`,
            ).toEqual(want)

            const rows = await raw.rows<{
              id: string
              email: string
              kind: AlertKind
              status: string
              baseline_price_minor: number | string | null
            }>(
              'SELECT id, email, kind, status, baseline_price_minor FROM alert_subscriptions WHERE variant_id = ?',
              [p.variantId],
            )
            const sent = (
              await eventRows(raw, 'seq > ? AND type = ?', [start, 'alert.sent.v1'])
            ).map((e) => (e.envelope.payload as { subscriptionId?: string }).subscriptionId)
            const seenRows = people.map((email) =>
              ALERT_KINDS.map((alert) => {
                const row = rows.find((r) => r.email === norm(email) && r.kind === alert)
                return row === undefined
                  ? ['none', null, 0]
                  : [
                      row.status,
                      row.baseline_price_minor === null ? null : Number(row.baseline_price_minor),
                      sent.filter((id) => id === row.id).length,
                    ]
              }),
            )
            const wantRows = model.map((r) =>
              ALERT_KINDS.map((alert) => [
                r[alert].state,
                r[alert].state === 'none' ? null : r[alert].baseline,
                r[alert].alerts,
              ]),
            )
            expect(seenRows, `${label}: [status, baseline, alert.sent.v1] per row`).toEqual(
              wantRows,
            )
            expect(await retriedSince(start), label).toEqual([])
          }

          for (const op of ops) {
            await apply(op)
            await delivered()
            await check(JSON.stringify(op))
          }

          const fromA = await subscribe(people[0]!, p.variantId, 'back_in_stock')
          const fromFresh = await subscribe(freshEmail('fresh'), p.variantId, 'back_in_stock')
          expect([fromA.status, fromA.text]).toEqual([fromFresh.status, fromFresh.text])
          subscribeModel(0, 'back_in_stock')
          await delivered()
          await check('a last subscribe from A')
        }),
        {
          numRuns: options.propertyRuns,
          examples: [
            [
              [
                { kind: 'subscribe', who: 0, alert: 'back_in_stock' },
                { kind: 'subscribe', who: 1, alert: 'back_in_stock' },
                { kind: 'subscribe', who: 0, alert: 'price_drop' },
                { kind: 'subscribe', who: 1, alert: 'price_drop' },
                { kind: 'confirm', who: 0, alert: 'back_in_stock' },
                { kind: 'confirm', who: 1, alert: 'back_in_stock' },
                { kind: 'confirm', who: 0, alert: 'price_drop' },
                { kind: 'confirm', who: 1, alert: 'price_drop' },
                { kind: 'soft' },
                { kind: 'feedback', what: 'complaint' },
                { kind: 'restock' },
                { kind: 'price', move: 'down', step: 500 },
                { kind: 'subscribe', who: 0, alert: 'back_in_stock' },
                { kind: 'subscribe', who: 1, alert: 'back_in_stock' },
                { kind: 'confirm', who: 1, alert: 'back_in_stock' },
                { kind: 'sellout' },
                { kind: 'restock' },
              ],
            ],
          ],
        },
      )
    }, 300_000)

    it(`AC-6: after a hard bounce for A, A is sent no alert confirmation but is still sent its welcome and order-placed mail, as a fresh address is sent all three (${dialect})`, async () => {
      const seeded = await seedVariant(k, 10)
      const bounced = freshEmail('bounced')
      const fresh = freshEmail('fresh')
      const answer = await send(jsonDelivery({ id: freshId(), events: [hardBounce(bounced)] }))
      expect(answer.data).toEqual({ received: true, events: 1 })
      await delivered()

      for (const email of [bounced, fresh]) {
        const res = await subscribe(email, seeded.variantId, 'back_in_stock')
        expect(res.status, res.text).toBe(202)
        await k.services.auth.register({
          email,
          password: 'correct-horse-battery',
          firstName: 'Feedback',
        })
        await checkoutOf(k, seeded, 1, email)
      }
      await delivered()

      const mailOf = (email: string) =>
        ['alert-confirm', 'welcome', 'order-placed'].map((t) => mailsTo(email, t).length)
      expect(mailOf(bounced)).toEqual([0, ...mailOf(fresh).slice(1)])
      expect(mailOf(fresh)).toEqual([1, 1, 1])
    })
  })
}
