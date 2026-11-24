import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import {
  STANDARD_EVENT_TYPES,
  type HttpAdapter,
  type NymbalEvent,
  type RequestContext,
  type RouteHandler,
  type SseEvent,
  type StreamHandler,
} from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createLogger } from '../logger.js'
import { registerEventsSseRoute } from './events-sse.js'

// The event-stream ticket check opens a stream for its own ticket and refuses, with `ticket.invalid` and without
// throwing, a ticket whose signature differs from it in one character or in length (one shorter, one longer, empty).
// A comparison that throws on a length mismatch would answer 500 instead.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const logger = createLogger({ pretty: false, level: 'error' })
const closers: Array<() => void> = []

afterEach(() => {
  for (const close of closers.splice(0)) close()
})

function context(overrides: Partial<RequestContext>): RequestContext {
  return {
    method: 'GET',
    path: '/api/admin/events',
    url: 'http://localhost/api/admin/events',
    params: {},
    query: {},
    body: null,
    headers: {},
    cookies: {},
    requestId: 'req',
    correlationId: 'corr',
    logger,
    ip: '127.0.0.1',
    ...overrides,
  }
}

function mounted() {
  const routes = new Map<string, RouteHandler>()
  const streams = new Map<string, StreamHandler>()
  const adapter: HttpAdapter = {
    registerRoute(method, path, handler) {
      routes.set(`${method} ${path}`, handler)
    },
    registerStreamRoute(method, path, handler) {
      streams.set(`${method} ${path}`, handler)
    },
    registerMiddleware() {},
    setDefaultHeaders() {},
    async start() {},
    async stop() {},
  }
  const eventBus = new InProcessEventBus({ logger })
  registerEventsSseRoute(adapter, {
    eventBus,
    documentStore: new InMemoryDocumentStore({ sweepIntervalMs: 0 }),
    ticketSecret: 'sse-ticket-secret-of-thirty-two-chars',
  })

  async function ticket(): Promise<string> {
    const issued = await routes.get('POST /api/admin/events/ticket')!(
      context({ method: 'POST', auth: { userId: 'admin-1', roles: ['admin'] } }),
    )
    return (issued.body as { data: { ticket: string } }).data.ticket
  }

  /** Opens the stream with `ticket`: its first event, or what the handler threw. */
  async function open(t: string): Promise<{ first?: SseEvent | undefined; threw?: string }> {
    const sent: SseEvent[] = []
    const onClose: Array<() => void> = []
    closers.push(() => onClose.forEach((f) => f()))
    try {
      await streams.get('GET /api/admin/events')!(context({ query: { ticket: t } }), {
        send: (event) => void sent.push(event),
        close: () => undefined,
        onClose: (f) => void onClose.push(f),
      })
    } catch (error) {
      return { threw: String(error) }
    }
    return { first: sent[0] }
  }

  /** Opens the stream with a ticket of its own: every frame it sends, and its close. */
  async function stream(): Promise<{ sent: SseEvent[]; close: () => void }> {
    const t = await ticket()
    const sent: SseEvent[] = []
    const onClose: Array<() => void> = []
    const close = () => onClose.splice(0).forEach((f) => f())
    closers.push(close)
    await streams.get('GET /api/admin/events')!(context({ query: { ticket: t } }), {
      send: (event) => void sent.push(event),
      close: () => undefined,
      onClose: (f) => void onClose.push(f),
    })
    return { sent, close }
  }

  return { ticket, open, stream, eventBus }
}

const INVALID = { first: { event: 'error', data: { code: 'ticket.invalid' } } }

describe('AC-20: the ticket check refuses a wrong signature without throwing', () => {
  it('AC-20: a signature one character different anywhere, one shorter, one longer or empty is refused as ticket.invalid without throwing, and the ticket itself still opens the stream', async () => {
    const store = mounted()
    const own = await store.ticket()
    const [body, sig] = own.split('.') as [string, string]

    const lengths = [sig.slice(0, -1), `${sig}A`, '']
    const byLength = []
    for (const s of lengths) byLength.push(await store.open(`${body}.${s}`))
    expect(byLength).toEqual(lengths.map(() => INVALID))

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: sig.length - 1 }),
        fc.constantFrom(...ALPHABET),
        async (at, replacement) => {
          fc.pre(sig[at] !== replacement)
          const forged = `${body}.${sig.slice(0, at)}${replacement}${sig.slice(at + 1)}`
          expect(await store.open(forged), `position ${at}`).toEqual(INVALID)
        },
      ),
      { numRuns: 200 },
    )

    const opened = await store.open(own)
    expect(opened.first?.event).toBe('connected')
  })
})

// What the admin stream carries: the groups it always has, the night shift's insights, and the seven product types an
// admin write publishes. Not `product.viewed.v1`, one per storefront page view with the viewer's id, nor any other group.
const STREAMED_GROUPS = ['order.', 'payment.', 'inventory.', 'adapter.', 'proposal.', 'insight.']
const INSIGHT_TYPES = ['insight.created.v1', 'insight.dismissed.v1']
const STREAMED_PRODUCT_TYPES = [
  'product.created.v1',
  'product.updated.v1',
  'product.deleted.v1',
  'product.published.v1',
  'product.unpublished.v1',
  'product.restocked.v1',
  'product.variant_price_changed.v1',
]
const streamed = (type: string): boolean =>
  STREAMED_GROUPS.some((group) => type.startsWith(group)) || STREAMED_PRODUCT_TYPES.includes(type)

function event(type: string, n: number): NymbalEvent<{ n: number }> {
  return {
    id: randomUUID(),
    type,
    timestamp: new Date(Date.UTC(2026, 10, 19, 10, 0, n)).toISOString(),
    source: 'test',
    correlationId: `corr-${n}`,
    payload: { n },
    metadata: { storeId: 'store-1', environment: 'development', version: '1' },
  }
}

describe('AC-2: the admin stream carries product changes and no storefront views', () => {
  it('AC-2: over any sequence of standard events, a ticketed stream sends one frame per order, payment, inventory, adapter, proposal, insight or admin product event, in publish order, each named by its type with { id, type, timestamp, payload }, and none for product.viewed.v1 or any other type (property)', async () => {
    const store = mounted()
    expect(
      STREAMED_PRODUCT_TYPES.every((type) => (STANDARD_EVENT_TYPES as readonly string[]).includes(type)),
      'the seven product types are standard types',
    ).toBe(true)
    expect(
      INSIGHT_TYPES.filter((type) => !(STANDARD_EVENT_TYPES as readonly string[]).includes(type)),
      'insight types the property cannot draw',
    ).toEqual([])

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...STANDARD_EVENT_TYPES), { minLength: 1, maxLength: 20 }),
        async (types) => {
          const { sent, close } = await store.stream()
          const published = types.map((type, n) => event(type, n))
          for (const e of published) await store.eventBus.publish(e)
          close()

          const frames = sent.filter((frame) => frame.event !== 'connected')
          const expected = published
            .filter((e) => streamed(e.type))
            .map((e) => ({
              id: e.id,
              event: e.type,
              data: { id: e.id, type: e.type, timestamp: e.timestamp, payload: e.payload },
            }))
          expect(frames.length, `frames for ${types.join(', ')}`).toBe(expected.length)
          expect(frames).toEqual(expected)
          expect(
            frames.filter((frame) => !streamed(String(frame.event))).map((f) => f.event),
            'frames of a type the stream must not carry',
          ).toEqual([])
        },
      ),
      { numRuns: 200 },
    )
  })
})
