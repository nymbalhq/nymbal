import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Order } from '@nymbalhq/types'
import { currentCorrelationId, runWithCorrelation } from '../events/correlation.js'
import { inOrderScope } from './order-correlation.js'

// inOrderScope reads only the order's metadata, so the rest of the order is left out.
const orderWith = (metadata: Record<string, unknown> | undefined) => ({ metadata }) as unknown as Order

const CALLER = 'http:caller'

describe('inOrderScope', () => {
  it("runs fn in the order's correlation id, whatever the caller's scope, and returns fn's result", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9._:-]{1,128}$/), fc.integer(), (id, result) => {
        const seen = runWithCorrelation(CALLER, () =>
          inOrderScope(orderWith({ correlationId: id }), () => ({ id: currentCorrelationId(), result })),
        )
        expect(seen).toEqual({ id, result })
      }),
    )
  })

  it("keeps the caller's scope for a null order, an order without metadata, or one whose id is not a string", () => {
    const orders: (Order | null)[] = [
      null,
      orderWith(undefined),
      orderWith({}),
      orderWith({ correlationId: 42 }),
      orderWith({ correlationId: null }),
    ]
    for (const order of orders) {
      expect(runWithCorrelation(CALLER, () => inOrderScope(order, () => currentCorrelationId()))).toBe(CALLER)
      expect(inOrderScope(order, () => currentCorrelationId())).toBeUndefined()
    }
  })
})
