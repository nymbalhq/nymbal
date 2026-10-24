import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EVT_INVENTORY_CHANGED } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../http.js'
import type { Kernel } from '../kernel.js'
import { adminClient, type AdminClient } from '../money.js'

// AC-3 at the route: every open admin tab receives every live event. Each admin SSE connection subscribes to the bus;
// on Redis Streams a subscription that shares a name with the other tabs' is one consumer of one group, so each event
// would reach one tab only. The route subscribes unnamed.

interface Tab {
  frames: Array<{ event: string; data: unknown }>
  close(): void
}

/** An admin SSE connection, as the admin app opens one: a fresh ticket, then GET /api/admin/events?ticket=. */
async function openTab(baseUrl: string, admin: AdminClient): Promise<Tab> {
  const ticket = await admin.call<{ ticket: string }>('POST', '/api/admin/events/ticket')
  if (ticket.status !== 200) throw new Error(`ticket: ${JSON.stringify(ticket.body)}`)
  const abort = new AbortController()
  const res = await fetch(
    `${baseUrl}/api/admin/events?ticket=${encodeURIComponent(ticket.body.data!.ticket)}`,
    { signal: abort.signal, headers: { accept: 'text/event-stream' } },
  )
  const tab: Tab = { frames: [], close: () => abort.abort() }
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const event = /^event: ?(.*)$/m.exec(raw)?.[1] ?? 'message'
          const data = raw
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.replace(/^data: ?/, ''))
            .join('\n')
          tab.frames.push({ event, data: data === '' ? null : (JSON.parse(data) as unknown) })
        }
      }
    } catch {
      // Aborted at the end of the test.
    }
  })()
  return tab
}

async function until(check: () => boolean, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

export function adminTabsSuite(bus: string, start: () => Promise<Kernel>): void {
  describe(`AC-3: every admin tab receives every live event (${bus})`, () => {
    let k: Kernel
    let served: ServedKernel
    const tabs: Tab[] = []

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
    }, 60_000)
    afterAll(async () => {
      for (const tab of tabs) tab.close()
      await served?.stop()
    })

    it('AC-3: three admin tabs open on one instance each receive one copy of each of three inventory events', async () => {
      const admin = await adminClient(k, served.baseUrl)
      for (let i = 0; i < 3; i++) tabs.push(await openTab(served.baseUrl, admin))
      await until(
        () => tabs.every((t) => t.frames.some((f) => f.event === 'connected')),
        'every tab to connect',
      )

      const variants = Array.from({ length: 3 }, () => `primitives-variant-${randomUUID()}`)
      for (const variantId of variants) {
        await k.publisher.publish(EVT_INVENTORY_CHANGED, {
          variantId,
          previousQty: 1,
          newQty: 2,
          reason: 'manual',
        })
      }
      const received = (tab: Tab): string[] =>
        tab.frames
          .filter((f) => f.event === EVT_INVENTORY_CHANGED)
          .map((f) => (f.data as { payload: { variantId: string } }).payload.variantId)
          .filter((id) => variants.includes(id))
      await until(
        () => tabs.every((t) => received(t).length >= variants.length),
        'every tab to receive every event',
      ).catch(() => undefined)

      for (const [i, tab] of tabs.entries()) {
        expect([...received(tab)].sort(), `tab ${i}`).toEqual([...variants].sort())
      }
      expect(tabs.map(received).flat().length).toBe(tabs.length * variants.length)
    }, 60_000)
  })
}
