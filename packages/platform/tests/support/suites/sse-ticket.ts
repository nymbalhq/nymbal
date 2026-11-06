import { createHmac, randomBytes } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { serveKernel, type ServedKernel } from '../http.js'
import type { Kernel } from '../kernel.js'
import { adminClient, type AdminClient } from '../money.js'

// An admin event-stream ticket opens one stream. However many opens of one ticket race, one is `connected` and every
// other is told `ticket.replayed` and closed; a ticket the ticket route never issued is refused even when it is signed
// with the store's own secret. On whichever document store the kernel runs (each caller names it).

export type ConfigureKernel = (config: NymbalConfig) => NymbalConfig

export interface SuiteKernel {
  kernel: Kernel
  drop(): Promise<void>
}

const TICKET_SECONDS = 60

interface FirstFrame {
  event: string
  data: { code?: string } | null
  /** Whether the server ended the stream after its first frame (read to the end for an `error`). */
  closed: boolean
}

/** Opens the stream with `ticket`, reads its first frame; an `error` frame is read on until the server closes it. */
async function openOnce(baseUrl: string, ticket: string): Promise<FirstFrame> {
  const abort = new AbortController()
  const res = await fetch(`${baseUrl}/api/admin/events?ticket=${encodeURIComponent(ticket)}`, {
    signal: abort.signal,
    headers: { accept: 'text/event-stream' },
  })
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    let end = -1
    while ((end = buffer.indexOf('\n\n')) === -1) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`stream ended before a frame: ${JSON.stringify(buffer)}`)
      buffer += decoder.decode(value, { stream: true })
    }
    const raw = buffer.slice(0, end)
    const event = /^event: ?(.*)$/m.exec(raw)?.[1] ?? 'message'
    const text = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.replace(/^data: ?/, ''))
      .join('\n')
    const data = text === '' ? null : (JSON.parse(text) as FirstFrame['data'])
    let closed = false
    if (event === 'error') {
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
      closed = true
    }
    return { event, data, closed }
  } finally {
    abort.abort()
  }
}

/** A ticket as the ticket route signs one (`<base64url payload>.<hmac-sha256 base64url>`), made here with `secret`. */
function signTicket(
  secret: string,
  payload: { uid: string; roles: string[]; iat: number; nonce: string },
): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

const outcome = (frame: FirstFrame): string =>
  frame.event === 'error' ? `error ${frame.data?.code ?? '?'}` : frame.event

export function sseTicketSuite(
  label: string,
  start: (configure: ConfigureKernel) => Promise<SuiteKernel>,
) {
  describe(`one SSE ticket opens one admin stream (${label})`, () => {
    const secret = randomBytes(32).toString('base64url')
    let suite: SuiteKernel
    let served: ServedKernel
    let admin: AdminClient

    async function ticket(): Promise<string> {
      const res = await admin.call<{ ticket: string }>('POST', '/api/admin/events/ticket')
      if (res.status !== 200) throw new Error(`ticket: ${res.status} ${JSON.stringify(res.body)}`)
      return res.body.data!.ticket
    }

    beforeAll(async () => {
      suite = await start((config) => ({
        ...config,
        security: { ...config.security, auth: { ...config.security.auth, jwtSecret: secret } },
      }))
      served = await serveKernel(suite.kernel)
      admin = await adminClient(suite.kernel, served.baseUrl)
    }, 60_000)

    afterAll(async () => {
      try {
        await served?.stop()
      } finally {
        await suite?.drop()
      }
    })

    it('AC-3: property: for k in 2..8, k opens of one ticket at once: exactly one is connected, k-1 are refused ticket.replayed and closed', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (k) => {
          const one = await ticket()
          const frames = await Promise.all(
            Array.from({ length: k }, () => openOnce(served.baseUrl, one)),
          )
          const outcomes = frames.map(outcome)
          const connected = frames.filter((f) => f.event === 'connected')
          const replayed = frames.filter(
            (f) => f.event === 'error' && f.data?.code === 'ticket.replayed' && f.closed,
          )
          expect(connected.length, `k=${k}: ${outcomes.join(', ')}`).toBe(1)
          expect(replayed.length, `k=${k}: ${outcomes.join(', ')}`).toBe(k - 1)
        }),
        { numRuns: 12 },
      )
    }, 60_000)

    it('AC-4: a ticket opens one stream and is replayed after; a ticket signed with the store’s secret whose nonce no ticket route issued is ticket.replayed; one older than 60 s is ticket.expired', async () => {
      const issued = await ticket()
      // The forged tickets carry the issued one's uid and roles: only the nonce (or the age) differs.
      const { uid } = JSON.parse(
        Buffer.from(issued.split('.')[0]!, 'base64url').toString('utf8'),
      ) as { uid: string }
      const first = await openOnce(served.baseUrl, issued)
      const again = await openOnce(served.baseUrl, issued)

      const now = Math.floor(Date.now() / 1000)
      const forged = signTicket(secret, {
        uid,
        roles: ['admin'],
        iat: now,
        nonce: randomBytes(12).toString('base64url'),
      })
      const neverIssued = await openOnce(served.baseUrl, forged)
      const stale = signTicket(secret, {
        uid,
        roles: ['admin'],
        iat: now - TICKET_SECONDS - 5,
        nonce: randomBytes(12).toString('base64url'),
      })
      const expired = await openOnce(served.baseUrl, stale)

      expect([first, again, neverIssued, expired].map(outcome)).toEqual([
        'connected',
        'error ticket.replayed',
        'error ticket.replayed',
        'error ticket.expired',
      ])
    })
  })
}
