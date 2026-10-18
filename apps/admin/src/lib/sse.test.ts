import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// The shared constants, read from source: the admin's dependency on @nymbalhq/types is part of P1-08 itself.
import { STANDARD_EVENT_TYPES } from '../../../../packages/types/src/index'
import { createSseClient } from './sse'

// P1-08 AC-2: the server names each SSE event by its type and sends `{ id, type, timestamp, payload }`
// (packages/platform/src/routes/events-sse.ts). The client must listen per type and hand the handler
// `(type, payload)`. Kills: listening on `message`/`event` only; passing the envelope or `data` instead of `payload`;
// a malformed frame that throws or stops later frames; an `error` that does not reconnect.

type Listener = (event: MessageEvent<string>) => void

/** An EventSource double with the browser's dispatch rules: a named event reaches only listeners for that name. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  closed = false
  onmessage: Listener | null = null
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  private readonly listeners = new Map<string, Listener[]>()

  constructor(url: string | URL) {
    this.url = String(url)
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    )
  }

  close(): void {
    this.closed = true
  }

  /** What the server's `event: <name>` + `data: <data>` frame dispatches. */
  emit(name: string, data: string): void {
    const event = new MessageEvent(name, { data })
    for (const listener of this.listeners.get(name) ?? []) listener(event)
    if (name === 'message') this.onmessage?.(event)
    if (name === 'error') this.onerror?.(event)
  }
}

let ticketRequests = 0

function stubNetwork(): void {
  FakeEventSource.instances = []
  ticketRequests = 0
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    if (url.pathname === '/api/csrf') {
      return new Response(JSON.stringify({ data: { token: 'csrf-tok' } }), { status: 200 })
    }
    if (url.pathname === '/api/admin/events/ticket') {
      ticketRequests += 1
      return new Response(JSON.stringify({ data: { ticket: `ticket-${ticketRequests}` } }), {
        status: 200,
      })
    }
    return new Response(JSON.stringify({ error: { code: 'not_mocked' } }), { status: 404 })
  })
}

function frame(type: string, payload: unknown): string {
  return JSON.stringify({ id: `evt-${type}`, type, timestamp: '2026-10-18T10:00:00.000Z', payload })
}

const payloadArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 8 }).filter((k) => k !== '__proto__'),
  fc.jsonValue({ maxDepth: 2 }),
  { maxKeys: 5 },
)

async function connected(received: Array<{ type: string; payload: unknown }>) {
  const client = createSseClient((type, payload) => {
    received.push({ type, payload })
  })
  client.connect()
  await vi.waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1))
  return client
}

beforeEach(() => {
  stubNetwork()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('P1-08 AC-2: named SSE events decoded', () => {
  it('AC-2: a named event reaches the handler as (type, payload), for every type in STANDARD_EVENT_TYPES', async () => {
    const received: Array<{ type: string; payload: unknown }> = []
    const client = await connected(received)
    const source = FakeEventSource.instances.at(-1)!

    for (const type of STANDARD_EVENT_TYPES) {
      const payload = { marker: `payload-of-${type}`, n: type.length }
      source.emit(type, frame(type, payload))
    }
    expect(received.map((r) => r.type)).toEqual([...STANDARD_EVENT_TYPES])
    received.forEach((r) =>
      expect(r.payload, r.type).toEqual({ marker: `payload-of-${r.type}`, n: r.type.length }),
    )

    fc.assert(
      fc.property(fc.constantFrom(...STANDARD_EVENT_TYPES), payloadArb, (type, payload) => {
        const before = received.length
        source.emit(type, frame(type, payload))
        expect(received.length).toBe(before + 1)
        expect(received.at(-1)!.type).toBe(type)
        // A JSON frame cannot carry -0 (fc.jsonValue generates it), so the wire form is the expectation.
        expect(received.at(-1)!.payload).toEqual(JSON.parse(JSON.stringify(payload)))
      }),
      { numRuns: 100 },
    )
    client.disconnect()
  })

  it('AC-2: malformed data is dropped without throwing, and the next well-formed event still arrives', async () => {
    const received: Array<{ type: string; payload: unknown }> = []
    const client = await connected(received)
    const source = FakeEventSource.instances.at(-1)!
    const notJson = fc.string({ minLength: 1 }).filter((s) => {
      try {
        JSON.parse(s)
        return false
      } catch {
        return true
      }
    })

    fc.assert(
      fc.property(fc.constantFrom(...STANDARD_EVENT_TYPES), notJson, (type, data) => {
        const before = received.length
        expect(() => source.emit(type, data)).not.toThrow()
        expect(received.length).toBe(before)
      }),
      { numRuns: 50 },
    )

    source.emit('order.placed.v1', frame('order.placed.v1', { after: 'malformed' }))
    expect(received).toEqual([{ type: 'order.placed.v1', payload: { after: 'malformed' } }])
    client.disconnect()
  })

  it('AC-2: an error event (ticket refused) closes the source, reconnects after a growing backoff with a new ticket, and the new connection decodes named events', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const received: Array<{ type: string; payload: unknown }> = []
    const client = await connected(received)

    /** Fails the source with a server `event: error` frame; returns the ms until the next EventSource opens. */
    async function failAndTimeReconnect(): Promise<number> {
      const failing = FakeEventSource.instances.at(-1)!
      const count = FakeEventSource.instances.length
      failing.emit('error', JSON.stringify({ code: 'ticket.forbidden' }))
      expect(failing.closed).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(FakeEventSource.instances.length, 'reconnected with no delay').toBe(count)
      let waited = 0
      while (FakeEventSource.instances.length === count && waited < 60_000) {
        await vi.advanceTimersByTimeAsync(50)
        waited += 50
      }
      expect(FakeEventSource.instances.length, 'no reconnect within 60 s').toBe(count + 1)
      return waited
    }

    const first = await failAndTimeReconnect()
    const second = await failAndTimeReconnect()
    expect(first).toBeGreaterThan(0)
    expect(second).toBeGreaterThanOrEqual(first)
    expect(ticketRequests).toBe(FakeEventSource.instances.length)

    const latest = FakeEventSource.instances.at(-1)!
    latest.emit(
      'order.shipped.v1',
      frame('order.shipped.v1', { orderId: 'o-1', trackingNumber: 'T', carrier: 'DHL' }),
    )
    expect(received).toEqual([
      {
        type: 'order.shipped.v1',
        payload: { orderId: 'o-1', trackingNumber: 'T', carrier: 'DHL' },
      },
    ])
    client.disconnect()
  })
})
