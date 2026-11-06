import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// The shared constants, read from source: the admin depends on @nymbalhq/types.
import { STANDARD_EVENT_TYPES } from '../../../../packages/types/src/index'
import { createSseClient } from './sse'

// AC-2: the server names each SSE event by its type and sends `{ id, type, timestamp, payload }`
// (packages/platform/src/routes/events-sse.ts). The client listens per type and hands the handler `(type, payload)`.

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
    if (name === 'open') this.onopen?.(event)
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

describe('AC-2: named SSE events decoded', () => {
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

describe('AC-2: onConnected marks each connection the server confirms', () => {
  /** Steps the backoff clock until the client has opened `n` connections; fails after 60 s. */
  async function awaitConnection(n: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(0)
    let waited = 0
    while (FakeEventSource.instances.length < n && waited < 60_000) {
      await vi.advanceTimersByTimeAsync(250)
      waited += 250
    }
    expect(FakeEventSource.instances.length, `connection ${n} within 60 s`).toBe(n)
  }

  // What the server sends once its subscription is live (packages/platform/src/routes/events-sse.ts).
  const connectedFrame = () => JSON.stringify({ at: '2026-10-27T10:00:00.000Z' })

  it('AC-2: onConnected runs once per `connected` frame across k reconnects, never on open alone or on a refused ticket, and domain events still reach onEvent unchanged (property)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // One entry per connection: true, the server confirms it; false, it refuses the ticket with an error frame.
    const attemptsArb = fc
      .array(fc.boolean(), { minLength: 3, maxLength: 7 })
      .filter((a) => a.includes(false) && a.filter(Boolean).length >= 2)

    await fc.assert(
      fc.asyncProperty(
        attemptsArb,
        fc.constantFrom(...STANDARD_EVENT_TYPES),
        payloadArb,
        async (attempts, type, payload) => {
          stubNetwork()
          let connectedCalls = 0
          const received: Array<{ type: string; payload: unknown }> = []
          const client = createSseClient(
            (t, p) => {
              received.push({ type: t, payload: p })
            },
            {
              onConnected: () => {
                connectedCalls += 1
              },
            },
          )
          client.connect()
          await awaitConnection(1)

          let confirmed = 0
          for (const [i, accepted] of attempts.entries()) {
            const source = FakeEventSource.instances.at(-1)!
            const last = i === attempts.length - 1
            source.emit('open', '')
            expect(connectedCalls, `attempt ${i}: open alone`).toBe(confirmed)

            // The server confirms the subscription, or refuses the ticket with an error frame and closes.
            source.emit(
              accepted ? 'connected' : 'error',
              accepted ? connectedFrame() : JSON.stringify({ code: 'ticket.forbidden' }),
            )
            confirmed += accepted ? 1 : 0
            expect(connectedCalls, `attempt ${i}: ${accepted ? 'confirmed' : 'refused'}`).toBe(
              confirmed,
            )

            const before = received.length
            if (accepted) source.emit(type, frame(type, payload))
            expect(received.length, `attempt ${i}: domain events`).toBe(before + (accepted ? 1 : 0))
            expect(connectedCalls, `attempt ${i}: after a domain event`).toBe(confirmed)

            // A confirmed stream drops (the API restarts); either way the client opens a new one.
            if (accepted && !last) source.emit('error', '')
            if (!last) await awaitConnection(i + 2)
          }

          expect(connectedCalls).toBe(attempts.filter(Boolean).length)
          expect(received).toEqual(
            attempts
              .filter(Boolean)
              .map(() => ({ type, payload: JSON.parse(JSON.stringify(payload)) as unknown })),
          )
          client.disconnect()
        },
      ),
      { numRuns: 25 },
    )
  })
})

describe('onDisconnected marks each lost stream', () => {
  type Attempt = 'confirmed' | 'refused' | 'ticket-fails'

  /**
   * The ticket endpoint answers 503 for the attempts planned to fail, a ticket otherwise; `hold(n)` may keep the n-th
   * request (from 0) waiting until it resolves.
   */
  function stubPlannedNetwork(
    plan: readonly Attempt[],
    hold: (n: number) => Promise<void> | undefined = () => undefined,
  ): () => number {
    FakeEventSource.instances = []
    let tickets = 0
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
        const n = tickets
        const attempt = plan[n]
        tickets += 1
        await hold(n)
        if (attempt === 'ticket-fails') {
          return new Response(
            JSON.stringify({ error: { code: 'events.unavailable', message: 'unavailable' } }),
            { status: 503 },
          )
        }
        return new Response(JSON.stringify({ data: { ticket: `ticket-${tickets}` } }), {
          status: 200,
        })
      }
      return new Response(JSON.stringify({ error: { code: 'not_mocked' } }), { status: 404 })
    })
    return () => tickets
  }

  /** Steps the backoff clock until `done()`; fails after 60 s. */
  async function until(done: () => boolean, what: string): Promise<void> {
    await vi.advanceTimersByTimeAsync(0)
    let waited = 0
    while (!done() && waited < 60_000) {
      await vi.advanceTimersByTimeAsync(250)
      waited += 250
    }
    expect(done(), `${what} within 60 s`).toBe(true)
  }

  const connectedFrame = () => JSON.stringify({ at: '2026-11-01T10:00:00.000Z' })

  // Kills: a client with no disconnect callback (the badge then says Live through an outage); one called twice per
  // loss, or only for one of the two ways a stream is lost; onConnected not called again after a reconnect.
  it('AC-8: over generated runs of confirmed streams that drop, refused streams and failed ticket requests, onDisconnected runs once per loss and onConnected once per confirmed stream (property)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const runArb = fc
      .array(fc.constantFrom<Attempt>('confirmed', 'refused', 'ticket-fails'), {
        minLength: 2,
        maxLength: 6,
      })
      .filter((run) => run.includes('confirmed') && run.some((a) => a !== 'confirmed'))

    await fc.assert(
      fc.asyncProperty(runArb, async (run) => {
        const ticketsAsked = stubPlannedNetwork(run)
        const calls = { connected: 0, disconnected: 0 }
        const client = createSseClient(() => {}, {
          onConnected: () => {
            calls.connected += 1
          },
          onDisconnected: () => {
            calls.disconnected += 1
          },
        })
        client.connect()

        const expected = { connected: 0, disconnected: 0 }
        for (const [i, attempt] of run.entries()) {
          const last = i === run.length - 1
          await until(() => ticketsAsked() === i + 1, `ticket request ${i + 1}`)
          if (attempt === 'ticket-fails') {
            expected.disconnected += 1
            await until(
              () => calls.disconnected >= expected.disconnected,
              `attempt ${i}: the failed ticket reported`,
            )
          } else {
            await until(
              () =>
                FakeEventSource.instances.length ===
                run.slice(0, i + 1).filter((a) => a !== 'ticket-fails').length,
              `attempt ${i}: the stream opened`,
            )
            const source = FakeEventSource.instances.at(-1)!
            source.emit('open', '')
            if (attempt === 'refused') {
              source.emit('error', JSON.stringify({ code: 'ticket.forbidden' }))
              expected.disconnected += 1
            } else {
              source.emit('connected', connectedFrame())
              expected.connected += 1
              // The API restarts: the confirmed stream drops.
              if (!last) {
                source.emit('error', '')
                expected.disconnected += 1
              }
            }
          }
          expect({ ...calls }, `after attempt ${i} (${attempt}) of ${JSON.stringify(run)}`).toEqual(
            expected,
          )
        }

        client.disconnect()
        await vi.advanceTimersByTimeAsync(60_000)
        expect(calls, `after disconnect() in ${JSON.stringify(run)}`).toEqual(expected)
        expect(calls.disconnected, 'losses').toBe(
          run.filter((a, i) => a !== 'confirmed' || i < run.length - 1).length,
        )
      }),
      { numRuns: 20 },
    )
  })

  // Kills: a failed ticket request not reported; one that fails after sign-out reported as a lost stream, or
  // rescheduling a connection nobody wants.
  it('AC-8: a failed ticket request calls onDisconnected once; the reconnect’s ticket failing after disconnect() calls nothing and asks for no other', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const ticketsAsked = stubPlannedNetwork(['ticket-fails', 'ticket-fails', 'confirmed'], (n) =>
      n === 1 ? hold : undefined,
    )
    const calls = { connected: 0, disconnected: 0 }
    const client = createSseClient(() => {}, {
      onConnected: () => {
        calls.connected += 1
      },
      onDisconnected: () => {
        calls.disconnected += 1
      },
    })
    client.connect()
    await until(() => ticketsAsked() === 2, 'the reconnect’s ticket request')
    const reported = { ...calls }

    client.disconnect()
    release()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(reported, 'after the first ticket failed').toEqual({ connected: 0, disconnected: 1 })
    expect(calls, 'after the held ticket failed past disconnect()').toEqual(reported)
    expect(ticketsAsked(), 'ticket requests').toBe(2)
    expect(FakeEventSource.instances.length).toBe(0)
  })
})
