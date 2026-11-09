import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { EVT_PROPOSAL_APPLIED, EVT_PROPOSAL_FAILED, type OrderRefundStatus } from '@nymbalhq/types'
import { auditRows } from '../audit.js'
import { checkoutOf, createKernel, seedVariant, type Dialect, type Kernel } from '../kernel.js'
import { storedMoney, storedRefunds } from '../money.js'
import { openRaw, type RawReader } from '../raw.js'
import { clockAt, openReplica, type Replica } from '../replica.js'
import {
  APPROVER,
  BOUND_MS,
  INTERRUPTED_CODE,
  INTERRUPTED_TEXT,
  NOW,
  PROPOSER,
  STUCK_AT,
  UNKNOWN_CODE,
  UNKNOWN_TEXT,
  readRow,
  recordEntry,
  recordingLogger,
  seedRow,
  settledEvents,
  sweeperWith,
  type StuckSweeperDeps,
} from '../stuck-proposals.js'
import { unaudited } from '../write-audit.js'
import type { SweeperHandle } from '../../../src/sweepers/index.js'

// A row an approval left `approved` when the process stopped settles from what the store can prove, and nothing runs
// again. Rows are seeded through the repositories and the sweeper ticks by hand on a fixed clock; the row, the event
// log and the audit log are read back afterwards.

const ADMIN_COMMANDS = [
  'order.confirm',
  'order.process',
  'order.cancel',
  'order.markDelivered',
  'order.ship',
  'order.addNote',
  'order.resendConfirmation',
  'product.create',
  'product.update',
  'product.delete',
  'product.publish',
  'product.unpublish',
  'product.archive',
  'product.duplicate',
  'inventory.adjust',
  'customer.addNote',
  'review.moderate',
] as const

const SHOPPER_COMMANDS = [
  'review.submit',
  'alert.subscribe',
  'alert.confirm',
  'alert.unsubscribe',
  'checkout.place',
  'order.requestLink',
  'customer.update',
  'customer.addAddress',
  'customer.removeAddress',
] as const

const SWEEP_COMMAND = 'proposal.sweepStuck'

/** A fresh, empty database: its target and how to drop it afterwards. */
export type FreshDatabase = () => Promise<{ target: string; drop(): Promise<void> }>

export function stuckProposalsSuite(dialect: Dialect, fresh: FreshDatabase): void {
  describe(`stuck proposals (${dialect})`, () => {
    let db: { target: string; drop(): Promise<void> }
    let kernel: Kernel
    let raw: RawReader
    const handles: SweeperHandle[] = []
    const replicas: Replica[] = []

    beforeAll(async () => {
      db = await fresh()
      kernel = await createKernel(
        dialect === 'sqlite'
          ? { dialect: 'sqlite', sqlitePath: db.target }
          : { dialect: 'postgres', postgresUrl: db.target },
      )
      raw = openRaw(dialect, db.target)
    }, 60_000)

    afterEach(async () => {
      for (const handle of handles.splice(0)) handle.stop()
      for (const replica of replicas.splice(0)) await replica.close()
    })

    afterAll(async () => {
      await raw?.close()
      await kernel?.close()
      await db?.drop()
    })

    function sweeper(over: Partial<StuckSweeperDeps> = {}): SweeperHandle {
      const handle = sweeperWith({
        store: kernel.store,
        proposals: kernel.repos.proposal,
        publisher: kernel.publisher,
        logger: kernel.logger,
        ...over,
      })
      handles.push(handle)
      return handle
    }

    const seed = (row: Parameters<typeof seedRow>[1]) => seedRow(kernel, row)
    const read = (id: string) => readRow(kernel, id)
    const entry = (
      row: Awaited<ReturnType<typeof seedRow>>,
      seedOf: Parameters<typeof recordEntry>[2] = {},
    ) => recordEntry(kernel, row, seedOf)

    const eventTypes = async (id: string) =>
      (await settledEvents(raw, id)).map((event) => event.type)

    /** The `proposal.sweepStuck` entries that name one proposal. */
    async function sweepEntries(proposalId: string) {
      const entries = await auditRows(raw, 'command = ?', [SWEEP_COMMAND])
      return entries.filter((e) => e.subjects.some((s) => s.id === proposalId))
    }

    const expectUnknown = async (id: string) => {
      const row = await read(id)
      expect(row.status).toBe('failed')
      expect(row.outcomeStatus).toBe(500)
      expect(row.outcomeCode).toBe(UNKNOWN_CODE)
      expect(row.outcomeMessage).toBe(UNKNOWN_TEXT)
      expect(await eventTypes(id)).toEqual([EVT_PROPOSAL_FAILED])
    }

    it('AC-1: property: an admin non-provider row past the bound with an applied entry under its approving admin settles applied with that entry’s status, settledAt after the decision, and one proposal.applied.v1', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...ADMIN_COMMANDS),
          fc.constantFrom(200, 201, 204),
          async (command, responseStatus) => {
            const row = await seed({ command })
            await entry(row, { responseStatus })
            await sweeper().tick()
            const settled = await read(row.id)
            expect(settled.status).toBe('applied')
            expect(settled.outcomeStatus).toBe(responseStatus)
            expect(new Date(settled.settledAt!).getTime()).toBeGreaterThan(
              new Date(row.decidedAt!).getTime(),
            )
            expect(await eventTypes(row.id)).toEqual([EVT_PROPOSAL_APPLIED])
          },
        ),
        { numRuns: 8 },
      )
    })

    it('AC-2: property: every admin non-provider command past the bound with no applied entry settles failed as interrupted with the merchant text and one proposal.failed.v1 carrying the code; a refused entry under the key changes nothing', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...ADMIN_COMMANDS),
          fc.boolean(),
          async (command, refused) => {
            const row = await seed({ command })
            if (refused) await entry(row, { outcome: 'refused', responseStatus: 409 })
            await sweeper().tick()
            const settled = await read(row.id)
            expect(settled.status).toBe('failed')
            expect({
              status: settled.outcomeStatus,
              code: settled.outcomeCode,
              message: settled.outcomeMessage,
            }).toEqual({ status: 500, code: INTERRUPTED_CODE, message: INTERRUPTED_TEXT })
            const events = await settledEvents(raw, row.id)
            expect(events.map((e) => e.type)).toEqual([EVT_PROPOSAL_FAILED])
            expect((events[0]!.envelope.payload as { outcome: { code: string } }).outcome.code).toBe(
              INTERRUPTED_CODE,
            )
          },
        ),
        { numRuns: 8 },
      )
    })

    it('AC-3: property, money: order.refund and order.markPaid past the bound read Outcome unknown with no applied entry and Applied with one, whatever the refund row or the order says, and the sweep moves no money, calls no provider and changes no order', async () => {
      const seeded = await seedVariant(kernel, 100_000)
      const payments = kernel.app.adapters.payments
      const refunds = vi.spyOn(payments, 'refund')
      const cancels = vi.spyOn(payments, 'cancelPaymentIntent')
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            command: fc.constantFrom('order.refund', 'order.markPaid'),
            applied: fc.boolean(),
            paid: fc.boolean(),
            refundRow: fc.constantFrom<OrderRefundStatus | null>(null, 'pending', 'succeeded'),
          }),
          async ({ command, applied, paid, refundRow }) => {
            const order = await checkoutOf(
              kernel,
              seeded,
              1,
              paid ? `paid-${randomUUID()}@sweep.test` : `open-${randomUUID()}+stub-pending@sweep.test`,
            )
            if (refundRow !== null) {
              await unaudited(() =>
                kernel.store.transaction((tx) =>
                  kernel.repos.orderRefund.insert(tx, {
                    id: randomUUID(),
                    orderId: order.orderId,
                    amountMinor: 1,
                    currency: 'GBP',
                    providerRefundId: refundRow === 'succeeded' ? `re_${randomUUID()}` : null,
                    status: refundRow,
                    reason: null,
                    actor: `admin:${APPROVER}`,
                    createdAt: new Date(),
                  }),
                ),
              )
            }
            const row = await seed({ command })
            if (applied) await entry(row, { responseStatus: 200 })
            const moneyBefore = await storedMoney(raw, order.orderId)
            const refundsBefore = await storedRefunds(raw, order.orderId)
            const refundCalls = refunds.mock.calls.length
            const cancelCalls = cancels.mock.calls.length

            await sweeper().tick()

            if (applied) {
              expect((await read(row.id)).status).toBe('applied')
              expect(await eventTypes(row.id)).toEqual([EVT_PROPOSAL_APPLIED])
            } else {
              await expectUnknown(row.id)
            }
            expect(await storedMoney(raw, order.orderId)).toEqual(moneyBefore)
            expect(await storedRefunds(raw, order.orderId)).toEqual(refundsBefore)
            expect(refunds.mock.calls.length).toBe(refundCalls)
            expect(cancels.mock.calls.length).toBe(cancelCalls)
          },
        ),
        { numRuns: 6 },
      )
      refunds.mockRestore()
      cancels.mockRestore()
    })

    it('AC-4: property: a shopper-scope row past the bound reads Outcome unknown, even with an applied entry under its correlation id and key', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...SHOPPER_COMMANDS),
          fc.boolean(),
          async (command, withEntry) => {
            const row = await seed({
              command,
              proposerId: null,
              decider: { kind: 'policy', rule: 'agents.autoApprove' },
            })
            if (withEntry) {
              await entry(row, { actorKind: 'guest', actorId: 'guest-1' })
              await entry(row, { actorId: PROPOSER })
            }
            await sweeper().tick()
            await expectUnknown(row.id)
          },
        ),
        { numRuns: 8 },
      )
    })

    it('AC-4: a row whose command names no route reads as Outcome unknown', async () => {
      const row = await seed({ command: 'retired.command' })
      await sweeper().tick()
      await expectUnknown(row.id)
    })

    it('AC-5: a policy-approved row reads the entry under its proposer, not under the rule that decided it', async () => {
      const ranAsProposer = await seed({
        command: 'product.update',
        decider: { kind: 'policy', rule: 'agents.autoApprove' },
      })
      await entry(ranAsProposer, { actorId: PROPOSER })
      const onlyUnderRule = await seed({
        command: 'product.update',
        decider: { kind: 'policy', rule: 'agents.autoApprove' },
      })
      await entry(onlyUnderRule, { actorId: 'agents.autoApprove' })

      await sweeper().tick()

      expect((await read(ranAsProposer.id)).status).toBe('applied')
      expect((await read(onlyUnderRule.id)).outcomeCode).toBe(INTERRUPTED_CODE)
    })

    it('AC-6: a row carrying the agent’s own idempotency key is looked up under that key, not proposal:<id>', async () => {
      const keyed = await seed({ command: 'product.update', idempotencyKey: `agent-${randomUUID()}` })
      await entry(keyed)
      const underDerivedKey = await seed({
        command: 'product.update',
        idempotencyKey: `agent-${randomUUID()}`,
      })
      await entry(underDerivedKey, { idempotencyKey: `proposal:${underDerivedKey.id}` })

      await sweeper().tick()

      expect((await read(keyed.id)).status).toBe('applied')
      expect((await read(underDerivedKey.id)).outcomeCode).toBe(INTERRUPTED_CODE)
    })

    it('AC-7: property: a row settles only when decided strictly before the bound; at the cutoff or younger, or pending, rejected, applied or failed however old, it is untouched, and a second tick changes nothing', async () => {
      const longAgo = new Date(NOW.getTime() - 30 * 24 * 3_600_000)
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(fc.constant(0), fc.integer({ min: 1, max: BOUND_MS })),
          fc.integer({ min: 1, max: 7 * 24 * 3_600_000 }),
          async (youngerBy, olderBy) => {
            const notStuck = await seed({
              command: 'product.update',
              decidedAt: new Date(NOW.getTime() - BOUND_MS + youngerBy),
            })
            const stuck = await seed({
              command: 'product.update',
              decidedAt: new Date(NOW.getTime() - BOUND_MS - olderBy),
            })
            const others = await Promise.all(
              (['pending', 'rejected', 'applied', 'failed'] as const).map((status) =>
                seed({ command: 'product.update', status, decidedAt: longAgo }),
              ),
            )
            const before = await Promise.all(others.map((r) => read(r.id)))

            const sweep = sweeper()
            await sweep.tick()

            expect((await read(stuck.id)).status).toBe('failed')
            expect(await read(notStuck.id)).toEqual(notStuck)
            expect(await Promise.all(others.map((r) => read(r.id)))).toEqual(before)
            const settledRow = await read(stuck.id)
            const eventsAfterFirst = await settledEvents(raw, stuck.id)
            expect(eventsAfterFirst).toHaveLength(1)

            await sweep.tick()

            expect(await read(stuck.id)).toEqual(settledRow)
            expect(await settledEvents(raw, stuck.id)).toEqual(eventsAfterFirst)
            expect(await settledEvents(raw, notStuck.id)).toEqual([])
          },
        ),
        { numRuns: 8 },
      )
    })

    it('AC-8: two sweeps at once over the same rows leave each row terminal with one settled event and one sweep entry', async () => {
      const second = await openReplica(dialect, db.target, { clock: clockAt(NOW) })
      replicas.push(second)
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 4, max: 10 }), async (count) => {
          const rows = await Promise.all(
            Array.from({ length: count }, () => seed({ command: 'product.update' })),
          )
          const a = sweeper()
          const b = sweeper({
            store: second.store,
            proposals: second.repos.proposal,
            publisher: second.publisher,
            logger: second.logger,
          })
          await Promise.all([a.tick(), b.tick()])

          for (const row of rows) {
            expect((await read(row.id)).status).toBe('failed')
            expect(await settledEvents(raw, row.id)).toHaveLength(1)
            expect(await sweepEntries(row.id)).toHaveLength(1)
          }
        }),
        { numRuns: 4 },
      )
    })

    it('AC-10: with 250 stuck rows and batchSize 100 one tick settles the 100 oldest decisions and three settle all', async () => {
      const oldest = STUCK_AT.getTime() - 3_600_000
      const rows = await Promise.all(
        Array.from({ length: 250 }, (_, i) =>
          seed({ command: 'product.update', decidedAt: new Date(oldest + i * 1_000) }),
        ),
      )
      const statusOf = async () =>
        Promise.all(rows.map(async (r) => ({ row: r, status: (await read(r.id)).status })))
      const sweep = sweeper({ batchSize: 100 })

      await sweep.tick()

      const afterOne = await statusOf()
      const settledFirst = afterOne.filter((r) => r.status !== 'approved').map((r) => r.row.id)
      const hundredOldest = [...rows]
        .sort((a, b) => a.decidedAt!.localeCompare(b.decidedAt!))
        .slice(0, 100)
        .map((r) => r.id)
      expect(settledFirst).toEqual(hundredOldest)

      await sweep.tick()
      await sweep.tick()

      const afterThree = await statusOf()
      expect(afterThree.filter((r) => r.status === 'approved')).toHaveLength(0)
    })

    it('AC-10: a row whose settle throws is logged and stays approved, the others settle, and tick does not reject', async () => {
      const bad = await seed({
        command: 'product.update',
        decidedAt: new Date(STUCK_AT.getTime() - 1_000),
      })
      const good = await Promise.all(
        Array.from({ length: 3 }, () => seed({ command: 'product.update' })),
      )
      const logger = recordingLogger()
      const proposals = kernel.repos.proposal
      const throwing = {
        ...proposals,
        async settle(tx: Parameters<typeof proposals.settle>[0], id: string, settlement: Parameters<typeof proposals.settle>[2]) {
          if (id === bad.id) throw new Error(`store refused ${bad.id}`)
          return proposals.settle(tx, id, settlement)
        },
      }
      const sweep = sweeper({ proposals: throwing, logger })

      await expect(sweep.tick()).resolves.toBeUndefined()

      expect((await read(bad.id)).status).toBe('approved')
      for (const row of good) expect((await read(row.id)).status).toBe('failed')
      expect(logger.problems.join('\n')).toContain(bad.id)

      // The next tick has no fault: the row is not left behind for the tests after this one.
      await sweeper().tick()
    })

    it('AC-11: each settled row has one sweep entry of its own: applied, actor system proposal-sweep, the proposal as subject, the row’s correlation; a tick that settles nothing writes no entry', async () => {
      const rows = await Promise.all(
        Array.from({ length: 3 }, () => seed({ command: 'product.update' })),
      )
      const sweep = sweeper()

      await sweep.tick()

      for (const row of rows) {
        const entries = await sweepEntries(row.id)
        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({
          outcome: 'applied',
          actorKind: 'system',
          actorId: 'proposal-sweep',
          subjects: [{ type: 'proposal', id: row.id }],
          correlationId: row.correlationId,
        })
      }
      const count = async () => (await auditRows(raw, 'command = ?', [SWEEP_COMMAND])).length
      const entriesBefore = await count()
      await sweep.tick()
      expect(await count()).toBe(entriesBefore)
    })
  })
}
