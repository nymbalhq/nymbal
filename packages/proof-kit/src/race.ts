export interface RaceOptions {
  contenders: number
}

export interface RaceOutcome<T> {
  won: T[]
  lost: unknown[]
}

/**
 * Starts `contenders` attempts in one synchronous pass, so every attempt has begun before any of them resumes from
 * its first await, then settles them all. A fulfilled attempt is a win; a rejection is a loss and is kept, not thrown.
 */
export async function race<T>(
  attempt: (i: number) => Promise<T>,
  opts: RaceOptions,
): Promise<RaceOutcome<T>> {
  if (!Number.isInteger(opts.contenders) || opts.contenders < 1) {
    throw new RangeError(`race: contenders must be a positive integer, got ${opts.contenders}`)
  }
  const started = Array.from({ length: opts.contenders }, (_, i) => (async () => attempt(i))())
  const settled = await Promise.allSettled(started)
  const won: T[] = []
  const lost: unknown[] = []
  for (const result of settled) {
    if (result.status === 'fulfilled') won.push(result.value)
    else lost.push(result.reason)
  }
  return { won, lost }
}

export interface StockLedger {
  initial: number
  final: number
  qtyPerWin: number
  wins: number
}

export type StockViolation =
  | { invariant: 'stock-non-negative'; final: number }
  | { invariant: 'wins-within-stock'; wins: number; initial: number; qtyPerWin: number }
  | { invariant: 'stock-conserved'; expectedFinal: number; final: number }

/** The stock invariants a race must keep; empty when all three hold. */
export function checkStock(ledger: StockLedger): StockViolation[] {
  const { initial, final, qtyPerWin, wins } = ledger
  const violations: StockViolation[] = []
  if (!(final >= 0)) violations.push({ invariant: 'stock-non-negative', final })
  if (!(wins * qtyPerWin <= initial)) {
    violations.push({ invariant: 'wins-within-stock', wins, initial, qtyPerWin })
  }
  const expectedFinal = initial - wins * qtyPerWin
  if (final !== expectedFinal)
    violations.push({ invariant: 'stock-conserved', expectedFinal, final })
  return violations
}
