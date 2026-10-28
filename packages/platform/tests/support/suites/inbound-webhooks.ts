import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import type { NymbalEvent } from '@nymbalhq/types'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { auditRows, rowsOf } from '../audit.js'
import { UUID_V7 } from '../correlation.js'
import { serveKernel, type ServedKernel } from '../http.js'
import {
  eventsOfParcel,
  insertRecord,
  postDelivery,
  recordsFor,
  customSlots,
  type Delivered,
} from '../inbound-webhooks.js'
import { checkoutOf, seedVariant, type Kernel } from '../kernel.js'
import { maxSeq } from '../outbox.js'
import { stubPaymentWebhook } from '../proof-kit.js'
import { openRaw, type RawReader } from '../raw.js'
import {
  createTestHooksAdapter,
  createTestHooksTaxAdapter,
  sampleBody,
  signedDelivery,
  tampered,
  TEST_HOOKS,
  TEST_HOOKS_EVENTS,
  type DeliveryBody,
  type SignedDelivery,
} from '../test-hooks.js'
import {
  captureFor,
  deliver,
  deliverCapture,
  failedFor,
  orderStatus,
  paidFor,
  processedCount,
  WEBHOOK_HANDLER,
} from '../webhooks.js'

// Inbound webhooks on one dialect, through the served kernel's real route. The store's shipping slot is the test
// provider (`test-hooks`), its tax slot a hooked provider whose name holds a dot (`order.sync`), and its payments the
// stub. Every record and event is read back through a second connection.

const HOOKS_HANDLER = `webhook:${TEST_HOOKS}`
const DOTTED = 'order.sync'
const DOTTED_TYPE = 'order.sync.updated.v1'

/** Types the test provider declares that break the type rule, so each break below breaks that rule and no other. */
const DECLARED_BREAKS = {
  prefix: [
    'other-hooks.parcel_updated.v1',
    'test-hook.parcel_updated.v1',
    'test-hooksx.parcel_updated.v1',
  ],
  kernel: ['payment.captured.v1', 'order.paid.v1'],
  unversioned: ['test-hooks.parcel_updated', 'test-hooks.parcel_updated.v0'],
} as const

/** The kernel options of the suite's store: pass them to createKernel with the dialect's storage. */
export function inboundWebhooksStore() {
  return {
    configure: customSlots('shipping', 'tax'),
    appOptions: {
      adapters: {
        shipping: createTestHooksAdapter({
          producesEvents: [
            ...TEST_HOOKS_EVENTS,
            ...DECLARED_BREAKS.prefix,
            ...DECLARED_BREAKS.kernel,
            ...DECLARED_BREAKS.unversioned,
          ],
        }),
        tax: createTestHooksTaxAdapter({ providerName: DOTTED, producesEvents: [DOTTED_TYPE] }),
      },
    },
  }
}

const objectPayload = fc.dictionary(
  fc.stringMatching(/^[a-z]{1,8}$/),
  fc.oneof(fc.integer(), fc.string({ maxLength: 8 }), fc.boolean()),
  { maxKeys: 3 },
)
const validEvent = fc.record({
  type: fc.constantFrom(...TEST_HOOKS_EVENTS),
  payload: objectPayload,
})

/** One event that breaks the type rule in one way, the rest of it valid. */
const BREAKS: Record<string, fc.Arbitrary<{ type: string; payload: unknown }>> = {
  'another provider’s prefix': fc.record({
    type: fc.constantFrom(...DECLARED_BREAKS.prefix),
    payload: objectPayload,
  }),
  'a kernel type': fc.record({
    type: fc.constantFrom(...DECLARED_BREAKS.kernel),
    payload: objectPayload,
  }),
  'a type not in producesEvents': fc.record({
    type: fc
      .stringMatching(/^[a-z][a-z0-9_]{0,10}$/)
      .map((name) => `test-hooks.undeclared_${name}.v1`),
    payload: objectPayload,
  }),
  'no .v<n>': fc.record({
    type: fc.constantFrom(...DECLARED_BREAKS.unversioned),
    payload: objectPayload,
  }),
  'a non-object payload': fc.record({
    type: fc.constantFrom(...TEST_HOOKS_EVENTS),
    payload: fc.oneof(
      fc.array(fc.integer(), { maxLength: 3 }),
      fc.string({ maxLength: 8 }),
      fc.integer(),
      fc.constant(null),
      fc.boolean(),
    ),
  }),
}

function tally(answers: Delivered[]) {
  return {
    received: answers.filter((a) => a.status === 200 && a.data?.received === true).length,
    deduped: answers.filter((a) => a.status === 200 && a.data?.deduped === true).length,
    failed: answers.filter((a) => a.status === 200 && a.data?.failed === true).length,
  }
}

async function sendAll(
  times: number,
  concurrent: boolean,
  send: () => Promise<Delivered>,
): Promise<Delivered[]> {
  if (concurrent) return Promise.all(Array.from({ length: times }, send))
  const answers: Delivered[] = []
  for (let i = 0; i < times; i += 1) answers.push(await send())
  return answers
}

export function inboundWebhooksSuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
): void {
  describe(`inbound webhooks (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader
    /** Every `test-hooks.*` event the named subscription was handed, through the relay. */
    const relayed: NymbalEvent<unknown>[] = []

    beforeAll(async () => {
      k = await start()
      await k.eventBus.subscribe(`${TEST_HOOKS}.*`, (event) => void relayed.push(event), {
        name: 'inbound-webhooks-listener',
      })
      served = await serveKernel(k)
      raw = openRaw(k.dialect, k.target)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    async function counts() {
      return { events: await raw.count('events'), records: await raw.count('processed_events') }
    }

    it(`AC-1: the stub store finalises a capture through /api/webhooks/native-stub, recorded under webhook:native-stub, by system:native-stub-webhook (${dialect})`, async () => {
      const seeded = await seedVariant(k, 3)
      const started = await checkoutOf(k, seeded, 1)
      const eventId = `evt_${randomUUID()}`
      const hook = captureFor(started, { eventId })

      const answer = await postDelivery(served.baseUrl, 'native-stub', {
        rawBody: Buffer.from(hook.body),
        headers: hook.headers,
      })

      expect(answer.status, JSON.stringify(answer.body)).toBe(200)
      expect(answer.data?.finalized).toBe(true)
      expect(await orderStatus(raw, started.orderId)).toBe('confirmed')
      expect(await paidFor(raw, started.orderId)).toHaveLength(1)
      expect({
        nativeStub: await recordsFor(raw, 'webhook:native-stub', eventId),
        stripe: await processedCount(raw, eventId),
      }).toEqual({ nativeStub: 1, stripe: 0 })
      const audit = await rowsOf(raw, answer.correlationId)
      expect(audit.map((r) => [r.outcome, `${r.actorKind}:${r.actorId}`, r.command])).toEqual([
        ['applied', 'system:native-stub-webhook', 'payment.finalize'],
      ])
    })

    it(`AC-3: a webhook:stripe record written before the upgrade dedupes its capture: 200 deduped, the order stays pending, no event appended (${dialect})`, async () => {
      const seeded = await seedVariant(k, 3)
      const started = await checkoutOf(k, seeded, 1)
      const eventId = `evt_${randomUUID()}`
      await insertRecord(k.dialect, k.target, WEBHOOK_HANDLER, eventId)
      const seqBefore = await maxSeq(raw)

      const answer = await deliverCapture(served.baseUrl, started, { eventId })

      expect(answer.status).toBe(200)
      expect(answer.data?.deduped).toBe(true)
      expect(await orderStatus(raw, started.orderId)).toBe('pending')
      expect(await maxSeq(raw)).toBe(seqBefore)
      expect(await processedCount(raw, eventId)).toBe(1)
    })

    it(`AC-4: a signed delivery of two events answers received with 2, appends both under kernel-minted ids, source webhook:test-hooks and the request’s correlation id, records it, relays both to a named test-hooks.* subscription, and audits it once (${dialect})`, async () => {
      const body = sampleBody(`dlv_${randomUUID()}`, 2)
      const parcelId = `parcel-${body.id}`
      // An adapter's draft may carry envelope fields; the kernel's own must win.
      const forged = {
        ...body,
        events: body.events.map((e) => ({
          ...(e as object),
          id: 'forged-id',
          source: 'forged-source',
          correlationId: 'forged-correlation',
        })),
      }
      const before = await counts()

      const answer = await postDelivery(served.baseUrl, TEST_HOOKS, signedDelivery(forged))

      expect(answer.status, JSON.stringify(answer.body)).toBe(200)
      expect(answer.data).toEqual({ received: true, events: 2 })
      const rows = await eventsOfParcel(raw, parcelId)
      expect(rows.map((r) => r.type)).toEqual(body.events.map((e) => (e as { type: string }).type))
      expect(rows.map((r) => r.envelope.payload)).toEqual(
        body.events.map((e) => (e as { payload: unknown }).payload),
      )
      expect(rows.map((r) => r.envelope.source)).toEqual(rows.map(() => HOOKS_HANDLER))
      expect(rows.map((r) => r.envelope.correlationId)).toEqual(
        rows.map(() => answer.correlationId),
      )
      expect(rows.map((r) => r.envelope.id)).toEqual(rows.map((r) => r.id))
      expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
      expect(rows.filter((r) => !UUID_V7.test(r.envelope.id))).toEqual([])
      expect(await recordsFor(raw, HOOKS_HANDLER, body.id)).toBe(1)
      expect(await counts()).toEqual({ events: before.events + 2, records: before.records + 1 })

      await vi.waitFor(
        () =>
          expect(relayed.filter((e) => rows.some((r) => r.id === e.id)).map((e) => e.id)).toEqual(
            rows.map((r) => r.id),
          ),
        { timeout: 5000, interval: 25 },
      )

      const audit = await rowsOf(raw, answer.correlationId)
      expect(
        audit.map((r) => [r.outcome, `${r.actorKind}:${r.actorId}`, r.command, r.subjects]),
      ).toEqual([
        [
          'applied',
          'system:test-hooks-webhook',
          'webhook.receive',
          [{ type: 'webhook', id: `${TEST_HOOKS}:${body.id}` }],
        ],
      ])

      const replay = await postDelivery(served.baseUrl, TEST_HOOKS, signedDelivery(forged))
      expect(replay.data).toEqual({ deduped: true })
      expect(await rowsOf(raw, replay.correlationId)).toEqual([])
    })

    it(`AC-4: an unsigned or tampered delivery answers 400 webhook.invalid and records and appends nothing (${dialect})`, async () => {
      const body = sampleBody(`dlv_${randomUUID()}`, 2)
      const signed = signedDelivery(body)
      const unsigned: SignedDelivery = {
        rawBody: signed.rawBody,
        headers: { 'content-type': 'application/json' },
      }
      const before = await counts()
      const auditBefore = (await auditRows(raw)).length

      const answers = [
        await postDelivery(served.baseUrl, TEST_HOOKS, unsigned),
        await postDelivery(served.baseUrl, TEST_HOOKS, tampered(signed)),
      ]

      expect(answers.map((a) => [a.status, a.error?.code])).toEqual([
        [400, 'webhook.invalid'],
        [400, 'webhook.invalid'],
      ])
      expect(await counts()).toEqual(before)
      expect((await auditRows(raw)).length).toBe(auditBefore)
      // The same bytes, signed, still go through: the refusals were the signature's.
      const accepted = await postDelivery(served.baseUrl, TEST_HOOKS, signed)
      expect(accepted.data).toEqual({ received: true, events: 2 })
      expect(await counts()).toEqual({ events: before.events + 2, records: before.records + 1 })
    })

    it(`AC-5: property: a delivery holding one event that breaks the type rule (another prefix, a kernel type, undeclared, unversioned, a non-object payload) answers 500 webhook.event_invalid and leaves the events and processed_events counts unchanged (${dialect})`, async () => {
      for (const [kind, bad] of Object.entries(BREAKS)) {
        await fc.assert(
          fc.asyncProperty(
            fc.array(validEvent, { maxLength: 2 }),
            bad,
            fc.array(validEvent, { maxLength: 1 }),
            fc.uuid(),
            async (head, broken, tail, id) => {
              const body: DeliveryBody = { id: `dlv_${id}`, events: [...head, broken, ...tail] }
              const before = await counts()
              const answer = await postDelivery(served.baseUrl, TEST_HOOKS, signedDelivery(body))
              const seen = `${kind}: ${JSON.stringify(broken)} → ${answer.status} ${JSON.stringify(answer.body)}`
              expect([answer.status, answer.error?.code], seen).toEqual([
                500,
                'webhook.event_invalid',
              ])
              expect(await counts(), seen).toEqual(before)
            },
          ),
          { numRuns: 2 },
        )
      }
    })

    it(`AC-5: property: an empty deliveryId, and a hooked provider whose name holds a dot publishing order.sync.updated.v1, each answer 500 webhook.event_invalid and leave both counts unchanged (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(validEvent, { minLength: 1, maxLength: 2 }), async (events) => {
          const before = await counts()
          const answer = await postDelivery(
            served.baseUrl,
            TEST_HOOKS,
            signedDelivery({ id: '', events }),
          )
          expect([answer.status, answer.error?.code]).toEqual([500, 'webhook.event_invalid'])
          expect(await counts()).toEqual(before)
        }),
        { numRuns: 2 },
      )
      await fc.assert(
        fc.asyncProperty(fc.uuid(), objectPayload, async (id, payload) => {
          const before = await counts()
          const answer = await postDelivery(
            served.baseUrl,
            DOTTED,
            signedDelivery({ id: `dlv_${id}`, events: [{ type: DOTTED_TYPE, payload }] }),
          )
          expect([answer.status, answer.error?.code], JSON.stringify(answer.body)).toEqual([
            500,
            'webhook.event_invalid',
          ])
          expect(await counts()).toEqual(before)
        }),
        { numRuns: 2 },
      )
    })

    it(`AC-5: a delivery whose valid events come before one kernel-type event publishes none of them and records nothing (${dialect})`, async () => {
      const body = sampleBody(`dlv_${randomUUID()}`, 3)
      body.events.push({ type: 'payment.captured.v1', payload: { parcelId: `parcel-${body.id}` } })
      const before = await counts()

      const answer = await postDelivery(served.baseUrl, TEST_HOOKS, signedDelivery(body))

      expect([answer.status, answer.error?.code]).toEqual([500, 'webhook.event_invalid'])
      expect(await eventsOfParcel(raw, `parcel-${body.id}`)).toEqual([])
      expect(await recordsFor(raw, HOOKS_HANDLER, body.id)).toBe(0)
      expect(await counts()).toEqual(before)
    })

    for (const concurrent of [false, true]) {
      const how = concurrent ? 'all at once' : 'one after another'

      it(`AC-6: property: one test-hooks delivery sent k times (2-5), ${how}, leaves one record and one copy of its events; one answer is received and the rest deduped (${dialect})`, async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 2, max: 5 }),
            fc.integer({ min: 1, max: 3 }),
            fc.uuid(),
            async (times, n, id) => {
              const body = sampleBody(`dlv_${id}`, n)
              const delivery = signedDelivery(body)
              const before = await counts()

              const answers = await sendAll(times, concurrent, () =>
                postDelivery(served.baseUrl, TEST_HOOKS, delivery),
              )

              const seen = answers.map((a) => `${a.status} ${JSON.stringify(a.body)}`).join('\n')
              expect(tally(answers), seen).toEqual({ received: 1, deduped: times - 1, failed: 0 })
              expect(answers.find((a) => a.data?.received === true)?.data?.events, seen).toBe(n)
              expect(await recordsFor(raw, HOOKS_HANDLER, body.id)).toBe(1)
              expect((await eventsOfParcel(raw, `parcel-${body.id}`)).length).toBe(n)
              expect(await counts()).toEqual({
                events: before.events + n,
                records: before.records + 1,
              })
            },
          ),
          { numRuns: 3 },
        )
      }, 60_000)

      it(`AC-6: property: one payment.failed delivery to /api/webhooks/stripe sent k times (2-5), ${how}, gives one payment.failed.v1 and one record; one answer is failed and the rest deduped (${dialect})`, async () => {
        const seeded = await seedVariant(k, 100)
        await fc.assert(
          fc.asyncProperty(fc.integer({ min: 2, max: 5 }), async (times) => {
            const started = await checkoutOf(k, seeded, 1)
            const eventId = `evt_${randomUUID()}`
            const hook = stubPaymentWebhook({
              kind: 'payment.failed',
              paymentIntentId: started.paymentIntent.id,
              amountMinor: started.totalMinor,
              currency: started.currency,
              eventId,
            })

            const answers = await sendAll(times, concurrent, async () => {
              const a = await deliver(served.baseUrl, hook)
              return { ...a, body: a, correlationId: null }
            })

            const seen = answers.map((a) => `${a.status} ${JSON.stringify(a.data)}`).join('\n')
            expect(tally(answers), seen).toEqual({ received: 0, deduped: times - 1, failed: 1 })
            expect(await failedFor(raw, { paymentId: started.paymentIntent.id })).toHaveLength(1)
            expect(await processedCount(raw, eventId)).toBe(1)
          }),
          { numRuns: 3 },
        )
      }, 60_000)
    }

    if (dialect === 'postgres') {
      it(`AC-6: a capture whose work throws once leaves no record and no order.paid; its retry is processed once (${dialect})`, async () => {
        const seeded = await seedVariant(k, 3)
        const started = await checkoutOf(k, seeded, 1)
        const eventId = `evt_${randomUUID()}`
        const inventory = k.services.inventory
        const original = inventory.commitReservation
        let calls = 0
        inventory.commitReservation = async (...args) => {
          calls += 1
          if (calls === 1) throw new Error('inventory unavailable')
          return original.apply(inventory, args)
        }
        try {
          const first = await deliverCapture(served.baseUrl, started, { eventId })
          expect(first.status).toBeGreaterThanOrEqual(500)
          expect(await processedCount(raw, eventId)).toBe(0)
          expect(await paidFor(raw, started.orderId)).toEqual([])

          const retry = await deliverCapture(served.baseUrl, started, { eventId })
          expect(retry.data?.finalized).toBe(true)
        } finally {
          inventory.commitReservation = original
        }
        expect(calls).toBe(2)
        expect(await orderStatus(raw, started.orderId)).toBe('confirmed')
        expect(await paidFor(raw, started.orderId)).toHaveLength(1)
        expect(await processedCount(raw, eventId)).toBe(1)
      })
    }
  })
}
