import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { checkStock, race, type StockLedger, type StockViolation } from '@nymbalhq/proof-kit/race'

// Acceptance tests for P1-01 AC-1 (race starts every attempt together and reports every outcome) and AC-2
// (checkStock is clean exactly when the three stock invariants hold, and names every one that breaks).

describe('AC-1: race starts every contender before any finishes, and reports every outcome', () => {
  it('AC-1: for any contenders in 2..64, every start precedes every finish; won holds every value, lost every rejection', async () => {
    const contendersWithLosers = fc
      .integer({ min: 2, max: 64 })
      .chain((n) => fc.array(fc.boolean(), { minLength: n, maxLength: n }))

    await fc.assert(
      fc.asyncProperty(contendersWithLosers, async (loses) => {
        const contenders = loses.length
        const log: Array<{ at: 'start' | 'finish'; i: number }> = []
        const reasons = new Map<number, Error>()

        const outcome = await race(
          async (i) => {
            log.push({ at: 'start', i })
            await Promise.resolve()
            log.push({ at: 'finish', i })
            if (loses[i]) {
              const reason = new Error(`lost ${i}`)
              reasons.set(i, reason)
              throw reason
            }
            return { i }
          },
          { contenders },
        )

        const starts = log.filter((e) => e.at === 'start').map((e) => e.i)
        const lastStart = log.map((e) => e.at).lastIndexOf('start')
        const firstFinish = log.findIndex((e) => e.at === 'finish')
        expect([...starts].sort((a, b) => a - b)).toEqual(
          Array.from({ length: contenders }, (_, i) => i),
        )
        expect(lastStart).toBeLessThan(firstFinish)

        expect(outcome.won.length + outcome.lost.length).toBe(contenders)
        const winners = loses.flatMap((lost, i) => (lost ? [] : [i]))
        expect(outcome.won.map((w) => w.i).sort((a, b) => a - b)).toEqual(winners)
        expect(new Set(outcome.lost)).toEqual(new Set(reasons.values()))
      }),
      { numRuns: 200 },
    )
  })
})

/** The violations a ledger must produce, from the spec's definitions, in invariant order. */
function expectedViolations(l: StockLedger): StockViolation[] {
  const out: StockViolation[] = []
  if (!(l.final >= 0)) out.push({ invariant: 'stock-non-negative', final: l.final })
  if (!(l.wins * l.qtyPerWin <= l.initial)) {
    out.push({
      invariant: 'wins-within-stock',
      wins: l.wins,
      initial: l.initial,
      qtyPerWin: l.qtyPerWin,
    })
  }
  const expectedFinal = l.initial - l.wins * l.qtyPerWin
  if (!(l.final === expectedFinal)) {
    out.push({ invariant: 'stock-conserved', expectedFinal, final: l.final })
  }
  return out
}

const byInvariant = (vs: StockViolation[]): StockViolation[] =>
  [...vs].sort((a, b) => a.invariant.localeCompare(b.invariant))

/** Clean ledgers (a correct run), lost updates, oversells and arbitrary ledgers. */
const ledgers: fc.Arbitrary<StockLedger> = fc.oneof(
  fc
    .record({ initial: fc.nat(200), qtyPerWin: fc.integer({ min: 1, max: 5 }) })
    .chain(({ initial, qtyPerWin }) =>
      fc.nat(Math.floor(initial / qtyPerWin)).map((wins) => ({
        initial,
        qtyPerWin,
        wins,
        final: initial - wins * qtyPerWin,
      })),
    ),
  fc
    .record({
      initial: fc.nat(200),
      qtyPerWin: fc.integer({ min: 1, max: 5 }),
      wins: fc.nat(100),
    })
    .chain((l) =>
      fc
        .integer({ min: -50, max: 50 })
        .map((delta) => ({ ...l, final: l.initial - l.wins * l.qtyPerWin + delta })),
    ),
  fc.record({
    initial: fc.integer({ min: -10, max: 200 }),
    final: fc.integer({ min: -300, max: 300 }),
    qtyPerWin: fc.integer({ min: 1, max: 5 }),
    wins: fc.nat(100),
  }),
)

describe('AC-2: checkStock names exactly the broken invariants', () => {
  it('AC-2: [] exactly when final >= 0, wins * qtyPerWin <= initial and final === initial - wins * qtyPerWin; otherwise every broken one, with its numbers', () => {
    let clean = 0
    let dirty = 0
    fc.assert(
      fc.property(ledgers, (ledger) => {
        const violations = checkStock(ledger)
        const expected = expectedViolations(ledger)
        if (expected.length === 0) clean += 1
        else dirty += 1
        expect(byInvariant(violations)).toMatchObject(byInvariant(expected))
      }),
      { numRuns: 1000 },
    )
    // Both sides of "exactly when" were exercised.
    expect(clean).toBeGreaterThan(0)
    expect(dirty).toBeGreaterThan(0)
  })

  it('AC-2: the lost update measured on the kernel today (50 orders for 3 units, stock 2) is reported, not clean', () => {
    const invariants = checkStock({ initial: 3, final: 2, qtyPerWin: 1, wins: 50 }).map(
      (v) => v.invariant,
    )
    expect(invariants.sort()).toEqual(['stock-conserved', 'wins-within-stock'])
  })
})
