import { ValidationError } from '../errors.js'

export interface Money {
  amount: number
  currency: string
}

export function money(amount: number, currency: string): Money {
  assertMinorUnits(amount)
  return { amount, currency }
}

export function assertMinorUnits(amount: number): void {
  if (!Number.isInteger(amount)) {
    throw new ValidationError(`Monetary amount must be an integer (minor units), got ${amount}`)
  }
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new ValidationError(
      `Currency mismatch: ${a.currency} vs ${b.currency}`,
    )
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b)
  return { amount: a.amount + b.amount, currency: a.currency }
}

export function sub(a: Money, b: Money): Money {
  assertSameCurrency(a, b)
  return { amount: a.amount - b.amount, currency: a.currency }
}

export function mulBy(m: Money, scalar: number): Money {
  if (!Number.isFinite(scalar)) {
    throw new ValidationError(`Scalar must be finite, got ${scalar}`)
  }
  return { amount: Math.round(m.amount * scalar), currency: m.currency }
}

export function sumMoney(values: Money[], currency: string): Money {
  const total = values.reduce((acc, m) => {
    assertSameCurrency(m, { amount: 0, currency })
    return acc + m.amount
  }, 0)
  return { amount: total, currency }
}

export function allocate(m: Money, weights: number[]): Money[] {
  if (weights.length === 0) return []
  const totalWeight = weights.reduce((s, w) => s + w, 0)
  if (totalWeight <= 0) {
    throw new ValidationError('allocate: sum of weights must be > 0')
  }
  const portions = weights.map((w) => Math.floor((m.amount * w) / totalWeight))
  let remainder = m.amount - portions.reduce((s, p) => s + p, 0)
  const result = portions.slice()
  let idx = 0
  while (remainder !== 0 && idx < result.length) {
    const delta = remainder > 0 ? 1 : -1
    result[idx] = (result[idx] ?? 0) + delta
    remainder -= delta
    idx += 1
  }
  return result.map((amount) => ({ amount, currency: m.currency }))
}
