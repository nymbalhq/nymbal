import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { canRefund, fulfilmentMoves, paymentState } from '@nymbalhq/types'
import type { OrderStatus } from '@nymbalhq/types'
import type { AdminOrder } from '@/types'
import {
  NAVIGATION_COMMANDS,
  matchCommands,
  orderCommands,
  type NavigationCommand,
  type OrderCommandId,
  type PaletteCommand,
} from './palette-commands'

// What the palette offers an order is judged against the shared move table and the stored amounts, as the server
// judges a command; what a typed query keeps is judged against a plain substring reading of the labels.

const STATUSES: OrderStatus[] = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
]

/** Captured ≥ 0, refunded ≤ captured, refundable ≤ what is left (a pending refund holds the rest), edges weighted. */
const amounts = fc.oneof(
  fc.constant({ capturedMinor: 0, refundedMinor: 0, refundableMinor: 0 }),
  fc
    .integer({ min: 1, max: 1_000_000 })
    .chain((capturedMinor) =>
      fc
        .oneof(
          fc.constant(0),
          fc.constant(capturedMinor),
          fc.integer({ min: 0, max: capturedMinor }),
        )
        .chain((refundedMinor) =>
          fc
            .oneof(
              fc.constant(0),
              fc.constant(capturedMinor - refundedMinor),
              fc.integer({ min: 0, max: capturedMinor - refundedMinor }),
            )
            .map((refundableMinor) => ({ capturedMinor, refundedMinor, refundableMinor })),
        ),
    ),
)

const orders = fc.tuple(fc.constantFrom(...STATUSES), amounts).map(
  ([status, m]) =>
    ({
      id: 'o-1',
      orderNumber: 'NYM-1001',
      status,
      capturedMinor: m.capturedMinor,
      refundedMinor: m.refundedMinor,
      currency: 'GBP',
      payment: {
        state: paymentState(m),
        capturedMinor: m.capturedMinor,
        refundedMinor: m.refundedMinor,
        refundableMinor: m.refundableMinor,
        currency: 'GBP',
        refunds: [],
      },
    }) as unknown as AdminOrder,
)

/** Each id with the rule it is offered by, in the listed order. */
const RULES: Array<[OrderCommandId, (order: AdminOrder) => boolean]> = [
  ['record-payment', (o) => o.status === 'pending' && o.payment.capturedMinor === 0],
  ['process', (o) => fulfilmentMoves(o.status, o.payment.state).includes('processing')],
  ['ship', (o) => fulfilmentMoves(o.status, o.payment.state).includes('shipped')],
  ['deliver', (o) => fulfilmentMoves(o.status, o.payment.state).includes('delivered')],
  ['refund', (o) => canRefund(o.status) && o.payment.refundableMinor > 0],
  [
    'cancel',
    (o) =>
      fulfilmentMoves(o.status, o.payment.state).includes('cancelled') &&
      o.payment.capturedMinor === 0,
  ],
  ['resend-confirmation', (o) => o.status !== 'pending' && o.status !== 'cancelled'],
]

describe('orderCommands', () => {
  it('AC-1: over any status and captured, refunded and refundable amounts, the palette offers exactly the commands the server accepts, in the listed order', () => {
    fc.assert(
      fc.property(orders, (order) => {
        const offered = orderCommands(order)
        const { capturedMinor } = order.payment

        expect(offered).toEqual(RULES.filter(([, rule]) => rule(order)).map(([id]) => id))

        const paidOrPastCancel =
          capturedMinor > 0 || ['shipped', 'delivered', 'cancelled'].includes(order.status)
        const refunded = order.payment.state === 'refunded'
        expect(
          paidOrPastCancel && offered.includes('cancel'),
          'Cancel on a paid, shipped, delivered or cancelled order',
        ).toBe(false)
        expect(
          refunded && (offered.includes('process') || offered.includes('ship')),
          'fulfilment work on a fully refunded order',
        ).toBe(false)
        expect(order.status === 'cancelled' ? offered : [], 'a cancelled order').toEqual([])
        expect(
          order.status === 'pending' && offered.includes('refund'),
          'a refund of an unsold order',
        ).toBe(false)
      }),
      { numRuns: 500 },
    )
  })
})

/** Letters in both cases, a digit, a dash and the whitespace a query may hold. */
const CHARS = ['a', 'b', 'c', 'A', 'B', 'C', 'x', 'Z', '1', '-', ' ', ' ', '\t']
const text = (maxLength: number) =>
  fc.array(fc.constantFrom(...CHARS), { maxLength }).map((cs) => cs.join(''))

const commandLists = fc
  .array(text(14), { maxLength: 12 })
  .map((labels) => labels.map((label, i): PaletteCommand => ({ id: `c-${i}`, label })))

/** A query of random terms, or pieces of the labels with their case flipped, so matches are common. */
const queryFor = (commands: PaletteCommand[]) =>
  fc.oneof(
    text(8),
    fc
      .array(
        fc
          .tuple(
            fc.constantFrom('', ...commands.map((c) => c.label)),
            fc.nat(14),
            fc.integer({ min: 1, max: 5 }),
          )
          .map(([label, from, len]) => label.slice(from, from + len)),
        { maxLength: 3 },
      )
      .chain((terms) =>
        fc
          .constantFrom(' ', '  ', '\t', ' \t ')
          .map((gap) => terms.join(gap))
          .chain((q) => fc.boolean().map((upper) => (upper ? q.toUpperCase() : q.toLowerCase()))),
      ),
  )

function reference(query: string, commands: readonly PaletteCommand[]): PaletteCommand[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  return commands.filter((c) => terms.every((t) => c.label.toLowerCase().includes(t)))
}

describe('NAVIGATION_COMMANDS', () => {
  it('AC-9: Go to Reports is one navigation command and it goes to /reports', () => {
    expect(
      NAVIGATION_COMMANDS.filter((c: NavigationCommand) => c.to === '/reports').map(
        (c: NavigationCommand) => c.label,
      ),
    ).toEqual(['Go to Reports'])
  })
})

describe('matchCommands', () => {
  it('AC-2: returns exactly the commands whose label holds every whitespace-separated term of the query, case-insensitively, in input order', () => {
    fc.assert(
      fc.property(
        commandLists.chain((commands) => fc.tuple(fc.constant(commands), queryFor(commands))),
        ([commands, query]) => {
          const kept = matchCommands(query, commands)
          const expected = reference(query, commands)
          expect(kept.map((c: PaletteCommand) => c.id)).toEqual(expected.map((c) => c.id))
          kept.forEach((c: PaletteCommand, i: number) =>
            expect(c, 'the caller’s own command object').toBe(expected[i]),
          )
        },
      ),
      { numRuns: 500 },
    )
  })

  it('AC-2: an empty or blank query returns every command, in input order', () => {
    fc.assert(
      fc.property(
        commandLists,
        fc.constantFrom('', ' ', '   ', '\t', ' \t '),
        (commands, blank) => {
          expect(matchCommands(blank, commands).map((c: PaletteCommand) => c.id)).toEqual(
            commands.map((c) => c.id),
          )
        },
      ),
    )
  })

  it('AC-2: "inv" keeps Go to Inventory alone, and "go PRO" keeps Go to Products and Go to Promotions but not New product', () => {
    expect(matchCommands('inv', NAVIGATION_COMMANDS).map((c: NavigationCommand) => c.to)).toEqual([
      '/inventory',
    ])
    expect(
      matchCommands('go PRO', NAVIGATION_COMMANDS).map((c: NavigationCommand) => c.to),
    ).toEqual(['/products', '/promotions'])
  })
})
