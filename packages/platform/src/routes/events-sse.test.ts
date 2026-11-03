import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  HttpAdapter,
  RequestContext,
  RouteHandler,
  SseEvent,
  StreamHandler,
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
  registerEventsSseRoute(adapter, {
    eventBus: new InProcessEventBus({ logger }),
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

  return { ticket, open }
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
