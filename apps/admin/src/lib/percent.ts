const PERCENT = /^(\d+)(?:\.(\d{1,2}))?$/

/**
 * The basis points of a percent typed as a decimal, read from its digits so no float multiply can be off by one:
 * parsePercentBps('12.5') -> 1250, parsePercentBps('0.07') -> 7. Null for anything else, or outside 0.01 to 99.99.
 */
export function parsePercentBps(text: string): number | null {
  const match = PERCENT.exec(text.trim())
  if (match === null) return null
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return bps >= 1 && bps <= 9999 ? bps : null
}

/** The text a percent input shows for basis points: toPercentInput(1000) -> '10', 1250 -> '12.5', 1 -> '0.01'. */
export function toPercentInput(bps: number): string {
  const whole = Math.floor(bps / 100)
  const fraction = String(bps % 100).padStart(2, '0').replace(/0+$/, '')
  return fraction === '' ? String(whole) : `${whole}.${fraction}`
}
