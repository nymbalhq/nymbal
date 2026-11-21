import { randomUUID } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Logger } from '@nymbalhq/types'
import * as sweepers from '../../src/sweepers/index.js'
import { auditRows } from '../support/audit.js'
import { address, createKernel, type Kernel } from '../support/kernel.js'
import { storedRefunds } from '../support/money.js'
import {
  answerListWith,
  insertRefund,
  listed,
  paidOrder,
  type ReconcileAnswer,
} from '../support/provider-refunds.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { captureLogs } from '../support/settings.js'

// The sweep over a SQLite kernel: the orders it picks up, what one bad order leaves behind, the audit trail, and the
// app's own interval. Order ids and row ages are written directly; the service that reconciles is a fake where only
// which orders were asked for is the point, and the real one where the row's outcome is.

const HOUR = 3_600_000
const MINUTE = 60_000

interface SweepDeps {
  store: Kernel['store']
  refunds: Kernel['repos']['orderRefund']
  service: { reconcileOrder(orderId: string): Promise<ReconcileAnswer> }
  logger: Logger
  intervalMs?: number
}

interface SweepHandle {
  tick(): Promise<void>
  stop(): void
}

function startSweep(deps: SweepDeps): SweepHandle {
  const start = (
    sweepers as unknown as { startRefundReconcileSweeper?: (deps: SweepDeps) => SweepHandle }
  ).startRefundReconcileSweeper
  return start === undefined ? { tick: async () => undefined, stop: () => undefined } : start(deps)
}

function realService(k: Kernel): SweepDeps['service'] {
  return k.services.refund as unknown as SweepDeps['service']
}

let k: Kernel
let raw: RawReader

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  raw = openRaw(k.dialect, k.target)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await k?.close()
})

afterEach(() => {
  vi.useRealTimers()
})

/** An imported order with no line items, cheap enough to make fifty of. */
async function bareOrder(): Promise<string> {
  const orderId = uuidv7()
  await k.services.order.importOrder({
    orderId,
    orderNumber: `SW-${randomUUID().slice(0, 8)}`,
    status: 'confirmed',
    customerId: null,
    email: `sweep-${randomUUID()}@money.test`,
    billingAddress: address,
    shippingAddress: address,
    lineItems: [],
    subtotalMinor: 1_000,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor: 1_000,
    currency: 'GBP',
    createdAt: new Date(),
    capturedMinor: 1_000,
    refundedMinor: 0,
    captureMethod: 'import',
  })
  return orderId
}

function fakeService() {
  const calls: string[] = []
  return {
    calls,
    service: {
      async reconcileOrder(orderId: string): Promise<ReconcileAnswer> {
        calls.push(orderId)
        return { recorded: 0, settled: 0, failed: 0 }
      },
    },
  }
}

const silent = captureLogs().logger

describe('the refund reconcile sweep', () => {
  // Defect: a pending row is not swept, or the batch is not bounded and oldest first.
  it('AC-10: one tick reconciles each order with a pending row older than 60 s, oldest first, at most 50, and skips younger rows and orders with none', async () => {
    const stale: string[] = []
    for (let i = 0; i < 52; i += 1) {
      const orderId = await bareOrder()
      await insertRefund(k, {
        id: randomUUID(),
        orderId,
        amountMinor: 100,
        status: 'pending',
        // Oldest first means the highest i is the first in line.
        createdAt: new Date(Date.now() - 2 * HOUR - i * MINUTE),
      })
      stale.push(orderId)
    }
    const young = await bareOrder()
    await insertRefund(k, {
      id: randomUUID(),
      orderId: young,
      amountMinor: 100,
      status: 'pending',
      createdAt: new Date(Date.now() - 30_000),
    })
    const settled = await bareOrder()
    await insertRefund(k, {
      id: randomUUID(),
      orderId: settled,
      amountMinor: 100,
      status: 'succeeded',
      createdAt: new Date(Date.now() - 3 * HOUR),
    })

    const { calls, service } = fakeService()
    const sweep = startSweep({
      store: k.store,
      refunds: k.repos.orderRefund,
      service,
      logger: silent,
    })
    try {
      await sweep.tick()
    } finally {
      sweep.stop()
    }

    const expected = [...stale].reverse().slice(0, 50)
    expect(calls).toEqual(expected)
    expect(calls).not.toContain(young)
    expect(calls).not.toContain(settled)
  })

  // Defect: one order's failure stops the sweep.
  it('AC-10: one order’s failure is logged and the next order still runs', async () => {
    const orders = [await bareOrder(), await bareOrder()]
    for (const [i, orderId] of orders.entries()) {
      await insertRefund(k, {
        id: randomUUID(),
        orderId,
        amountMinor: 100,
        status: 'pending',
        createdAt: new Date(Date.now() - 4 * HOUR - i * MINUTE),
      })
    }
    const logs = captureLogs()
    const calls: string[] = []
    const broken = [orders[1]!, orders[0]!]
    const sweep = startSweep({
      store: k.store,
      refunds: k.repos.orderRefund,
      service: {
        async reconcileOrder(orderId) {
          calls.push(orderId)
          if (orderId === broken[0]) throw new Error('provider unavailable for this order')
          return { recorded: 0, settled: 0, failed: 0 }
        },
      },
      logger: logs.logger,
    })
    try {
      await sweep.tick()
    } finally {
      sweep.stop()
    }

    expect(calls).toContain(broken[1])
    expect(calls.filter((id) => id === broken[0])).toHaveLength(1)
    const errored = logs.calls.filter((c) => c.level === 'error').map((c) => JSON.stringify(c.obj))
    expect(errored.some((line) => line.includes(broken[0]!))).toBe(true)
  })

  // Defect: every tick writes audit noise, or a settling tick leaves no trail.
  it('AC-10: a tick that changes nothing writes no audit entry; one that settles a row writes one order.reconcileRefunds entry by system/refund-reconcile naming the order', async () => {
    const order = await paidOrder(k)
    const rowId = randomUUID()
    const providerId = `re_${randomUUID()}`
    await insertRefund(k, {
      id: rowId,
      orderId: order.orderId,
      amountMinor: 900,
      status: 'pending',
      providerRefundId: providerId,
      // Older than the rows the earlier tests leave pending on this kernel: the batch takes the oldest 50 first.
      createdAt: new Date(Date.now() - 8 * HOUR),
    })
    const entriesBefore = (await auditRows(raw, "command = 'order.reconcileRefunds'")).length
    const sweep = startSweep({
      store: k.store,
      refunds: k.repos.orderRefund,
      service: realService(k),
      logger: silent,
    })
    try {
      const unchanged = answerListWith(k.app.adapters.payments, () => [])
      try {
        await sweep.tick()
      } finally {
        unchanged.restore()
      }
      expect((await auditRows(raw, "command = 'order.reconcileRefunds'")).length).toBe(
        entriesBefore,
      )

      const settling = answerListWith(k.app.adapters.payments, (paymentId) => [
        listed(paymentId, {
          refundId: providerId,
          amountMinor: 900,
          status: 'succeeded',
          idempotencyKey: rowId,
        }),
      ])
      try {
        await sweep.tick()
      } finally {
        settling.restore()
      }
    } finally {
      sweep.stop()
    }

    const entries = await auditRows(raw, "command = 'order.reconcileRefunds'")
    expect(entries).toHaveLength(entriesBefore + 1)
    const entry = entries.at(-1)!
    expect(entry.actorKind).toBe('system')
    expect(entry.actorId).toBe('refund-reconcile')
    expect(entry.subjects.map((s) => s.id)).toContain(order.orderId)
    expect((await storedRefunds(raw, order.orderId))[0]!.status).toBe('succeeded')
  })

  // Defect: stop() leaves the interval running.
  it('AC-10: the interval runs ticks until stop(), after which no tick runs', async () => {
    const orderId = await bareOrder()
    await insertRefund(k, {
      id: randomUUID(),
      orderId,
      amountMinor: 100,
      status: 'pending',
      createdAt: new Date(Date.now() - 5 * HOUR),
    })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { calls, service } = fakeService()
    const sweep = startSweep({
      store: k.store,
      refunds: k.repos.orderRefund,
      service,
      logger: silent,
      intervalMs: 1_000,
    })
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0))
    sweep.stop()
    const afterStop = calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls.length).toBe(afterStop)
  })

  /** A pending row the sweep settles, on a kernel of its own; fires only the intervals of `delay` the boot registered. */
  async function sweepAt(
    options: { refundReconcileSweep?: { intervalMs?: number } },
    delay: number,
  ): Promise<string> {
    const spy = vi.spyOn(globalThis, 'setInterval')
    let booted: Kernel
    let intervals: Array<[(...a: unknown[]) => void, number | undefined]>
    try {
      booted = await createKernel({
        dialect: 'sqlite',
        appOptions: options as unknown as NonNullable<
          Parameters<typeof createKernel>[0]['appOptions']
        >,
      })
      intervals = spy.mock.calls.map(
        ([fn, ms]) => [fn as (...a: unknown[]) => void, ms] as const,
      ) as typeof intervals
    } finally {
      spy.mockRestore()
    }
    const reader = openRaw(booted.dialect, booted.target)
    try {
      const order = await paidOrder(booted)
      const rowId = randomUUID()
      await insertRefund(booted, {
        id: rowId,
        orderId: order.orderId,
        amountMinor: 700,
        status: 'pending',
        createdAt: new Date(Date.now() - 2 * HOUR),
      })
      const listing = answerListWith(booted.app.adapters.payments, (paymentId) => [
        listed(paymentId, {
          refundId: `re_${randomUUID()}`,
          amountMinor: 700,
          status: 'succeeded',
          idempotencyKey: rowId,
        }),
      ])
      try {
        for (const [fn, ms] of intervals) if (ms === delay) fn()
        await vi
          .waitFor(
            async () => {
              const [row] = await storedRefunds(reader, order.orderId)
              if (row!.status !== 'succeeded') throw new Error('the sweep has not settled the row')
            },
            { timeout: 8_000, interval: 50 },
          )
          .catch(() => undefined)
      } finally {
        listing.restore()
      }
      return (await storedRefunds(reader, order.orderId))[0]!.status
    } finally {
      await reader.close()
      await booted.close()
    }
  }

  // Defect: the app never starts the sweep, or a custom interval is ignored.
  it('AC-10: the app starts the sweep every 5 minutes by default', async () => {
    expect(await sweepAt({}, 5 * MINUTE)).toBe('succeeded')
  }, 60_000)

  it('AC-10: the option overrides the interval', async () => {
    expect(await sweepAt({ refundReconcileSweep: { intervalMs: 123_456 } }, 123_456)).toBe('succeeded')
  }, 60_000)
})
