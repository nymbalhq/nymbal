import type { Address, Logger } from '@nymbalhq/types'

// What the EasyPost unit tests share: a silent logger, one that keeps every line, two US addresses, and the strings
// anything reachable from a value holds (for the key-leak checks).

export const silent: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
}

/** A logger that keeps every call's arguments, its children's too. */
export function recordingLogger(): { logger: Logger; lines: unknown[] } {
  const lines: unknown[] = []
  const make = (bindings: unknown): Logger => {
    const at = (level: string) => (obj: unknown, msg?: string) => {
      lines.push({ level, bindings, obj, msg })
    }
    return {
      trace: at('trace'),
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      child: (more) => make({ bindings, more }),
    }
  }
  return { logger: make({}), lines }
}

export const FROM: Address = {
  firstName: 'Nymbal',
  lastName: 'Warehouse',
  company: 'Nymbal Test',
  addressLine1: '417 Montgomery Street',
  addressLine2: 'Floor 5',
  city: 'San Francisco',
  region: 'CA',
  postalCode: '94104',
  country: 'US',
  phone: '4155559999',
}

export const TO: Address = {
  firstName: 'Dr Steve',
  lastName: 'Brule',
  addressLine1: '179 N Harbor Dr',
  city: 'Redondo Beach',
  region: 'CA',
  postalCode: '90277',
  country: 'US',
}

/** What a call left behind: its value, or the error it rejected or threw with, and how long it took. */
export async function outcomeOf<T>(
  call: () => Promise<T> | T,
): Promise<{ value?: T; error?: unknown; ms: number }> {
  const started = Date.now()
  try {
    return { value: await call(), ms: Date.now() - started }
  } catch (error) {
    return { error, ms: Date.now() - started }
  }
}

/** The error's code, or undefined for a value that has none. */
export const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code

/** Every string reachable from `values`: keys and values, deeply, Errors' message, stack, cause and own properties. */
export function stringsIn(values: unknown[]): string[] {
  const out: string[] = []
  const seen = new WeakSet<object>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 12) return
    if (typeof value === 'string') return void out.push(value)
    if (typeof value !== 'object' || value === null) return
    if (seen.has(value)) return
    seen.add(value)
    const keys =
      value instanceof Error
        ? [...new Set(['message', 'stack', 'cause', ...Object.getOwnPropertyNames(value)])]
        : Object.keys(value)
    for (const key of keys) {
      out.push(key)
      visit((value as Record<string, unknown>)[key], depth + 1)
    }
  }
  for (const value of values) visit(value, 0)
  return out
}
