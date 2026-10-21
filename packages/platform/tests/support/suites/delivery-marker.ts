import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EVT_PRODUCT_CREATED,
  type NymbalEvent,
  type ProductCreatedV1Payload,
} from '@nymbalhq/types'
import type { Kernel } from '../kernel.js'

// P2-02 AC-3 on a composed kernel, one bus per run (spec P2-02-primitives-are-protocols, decision 4, M2):
// - a subscriber whose handler runs a command (which asks the relay to drain, publisher.ts afterCommit) must not wait
//   on the pass that is waiting on that handler. The handler is wrapped by the relay's asDelivery, as the app wraps
//   every handler on the bus it hands subscribers, so it runs inside the relay's delivery context whether the bus calls
//   it inside `publish` (in-process) or from a stream consumer loop (Redis Streams);
// - a read straight after a command sees its projection (the invariant publish-after-handlers exists for).
// Kills: the delivery marker set only around `publish`, so a consumer-loop handler's drain waits on its own delivery
// and the outer command stalls until the bus times the publish out; a bus whose publish resolves before the projection.

function product(slug: string) {
  return { slug, name: 'P2-02', description: '', status: 'active' as const, variants: [] }
}

export function deliveryMarkerSuite(
  bus: string,
  start: () => Promise<Kernel>,
  /** Under this, the outer command did not wait on a timeout: half the bus's ackTimeoutMs, or a deadline in-process. */
  boundMs: number,
): void {
  describe(`P2-02 AC-3: commands and their handlers on ${bus}`, () => {
    let k: Kernel

    beforeAll(async () => {
      k = await start()
    }, 60_000)
    afterAll(async () => {
      await k?.close()
    })

    it('AC-3: a product created by a handler of product.created, through asDelivery, lets the outer create resolve well before the bus timeout, and the inner create completes', async () => {
      const outerSlug = `p2-02-outer-${randomUUID()}`
      const inner: Array<Promise<string>> = []
      await k.eventBus.subscribe(
        EVT_PRODUCT_CREATED,
        k.app.relay.asDelivery(async (event: NymbalEvent) => {
          if ((event.payload as ProductCreatedV1Payload).product.slug !== outerSlug) return
          // A command from inside a handler: its afterCommit drain is the one that must not wait on this delivery.
          const created = k.services.product.create(product(`p2-02-inner-${randomUUID()}`))
          inner.push(created.then((p) => p.id))
          await created
        }),
        { name: 'p2-02-drain-probe' },
      )

      const timedOut = Symbol('timed out')
      const startedAt = Date.now()
      const outcome = await Promise.race([
        k.services.product.create(product(outerSlug)),
        new Promise<typeof timedOut>((r) => setTimeout(() => r(timedOut), boundMs * 4).unref()),
      ])
      const elapsed = Date.now() - startedAt

      expect(outcome, 'the outer create never resolved').not.toBe(timedOut)
      expect(elapsed).toBeLessThan(boundMs)
      expect(inner.length).toBe(1)
      const innerId = await inner[0]!
      expect((await k.services.product.getById(innerId))?.id).toBe(innerId)
    }, 60_000)

    it('AC-3: a product is readable from its projection straight after the create resolves, for every one of several', async () => {
      const slugs = Array.from({ length: 5 }, () => `p2-02-ryw-${randomUUID()}`)
      const misses: string[] = []
      for (const slug of slugs) {
        const created = await k.services.product.create(product(slug))
        const read = await k.documentStore.get<{ id: string }>('products', slug)
        if (read?.id !== created.id) misses.push(slug)
      }
      expect(misses).toEqual([])
      expect(slugs.length - misses.length).toBe(slugs.length)
    }, 60_000)
  })
}
