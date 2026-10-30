import type { CommerceSlot, Slot } from '@nymbalhq/types'

/**
 * What a slot's provider may be called: lower-case letters, digits and hyphens, starting with a letter or digit. The
 * bound keeps every convention name within npm's 214 characters.
 */
export const PROVIDER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

/** A slot as its package names and folders spell it: `documentStore` is `document-store`. */
export function slotFolder(slot: Slot): string {
  return slot.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

/** The package a provider lives in when the config names no `package`: `@nymbalhq/<slot folder>-<provider>`. */
export function conventionPackage(slot: Slot, provider: string): string {
  return `@nymbalhq/${slotFolder(slot)}-${provider}`
}

export interface CatalogueEntry {
  /** The kernel's own provider, which no package holds. */
  builtIn?: true
  /** The SDK the provider's package peers, which the project installs beside it. */
  sdk?: string
}

const builtIn = { builtIn: true } as const

/**
 * The providers Nymbal ships, by slot: the kernel's built-ins and the first-party packages, each with the SDK it peers.
 * It never decides what loads; it gives install lines, suggestions for a mistyped provider and `nymbal add`'s list.
 */
export const ADAPTER_CATALOGUE: Readonly<Record<Slot, Readonly<Record<string, CatalogueEntry>>>> = {
  payments: { native: builtIn, stripe: { sdk: 'stripe' } },
  email: {
    native: builtIn,
    smtp: { sdk: 'nodemailer' },
    mailgun: { sdk: 'nodemailer' },
    resend: { sdk: 'nodemailer' },
    ses: { sdk: 'nodemailer' },
  },
  reviews: { native: builtIn },
  search: { native: builtIn, algolia: {} },
  analytics: { native: builtIn },
  shipping: { native: builtIn, easypost: {} },
  tax: { native: builtIn },
  ai: { none: builtIn, anthropic: { sdk: '@anthropic-ai/sdk' } },
  documentStore: {
    'in-memory': builtIn,
    redis: { sdk: 'ioredis' },
    'postgres-jsonb': { sdk: 'pg' },
  },
  eventBus: { 'in-process': builtIn, 'redis-streams': { sdk: 'ioredis' } },
  media: { 'local-fs': builtIn, s3: { sdk: '@aws-sdk/client-s3' } },
  security: { middleware: builtIn, cloudflare: {} },
}

const SLOTS = Object.keys(ADAPTER_CATALOGUE) as Slot[]

/** Each slot's built-in providers: the kernel's own adapter is used, and nothing is imported. */
export const BUILT_IN: Readonly<Record<Slot, readonly string[]>> = Object.fromEntries(
  SLOTS.map((slot) => [
    slot,
    Object.entries(ADAPTER_CATALOGUE[slot])
      .filter(([, entry]) => entry.builtIn === true)
      .map(([name]) => name),
  ]),
) as unknown as Record<Slot, readonly string[]>

export const COMMERCE_SLOTS = [
  'payments',
  'email',
  'reviews',
  'search',
  'analytics',
  'shipping',
  'tax',
  'ai',
] as const satisfies readonly CommerceSlot[]

export function isCommerceSlot(slot: Slot): slot is CommerceSlot {
  return (COMMERCE_SLOTS as readonly string[]).includes(slot)
}

/** Optimal string alignment distance: insertions, deletions, substitutions and adjacent transpositions. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1)
      }
      d[i]![j] = best
    }
  }
  return d[a.length]![b.length]!
}

const MAX_SUGGESTION_DISTANCE = 2

/**
 * The catalogue name `name` was most likely meant to be, among the slot's catalogue names and, on a commerce slot,
 * `custom`: the nearest within two edits, the alphabetically first on a tie; none when nothing is that near.
 */
export function suggestProvider(slot: Slot, name: string): string | undefined {
  const candidates = [
    ...Object.keys(ADAPTER_CATALOGUE[slot]),
    ...(isCommerceSlot(slot) ? ['custom'] : []),
  ].sort()
  let best: { name: string; distance: number } | undefined
  for (const candidate of candidates) {
    const distance = editDistance(candidate, name)
    if (distance > MAX_SUGGESTION_DISTANCE) continue
    if (best === undefined || distance < best.distance) best = { name: candidate, distance }
  }
  return best?.name
}
