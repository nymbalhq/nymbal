import type { CommerceSlot } from '@nymbalhq/types'

export type { CommerceSlot }

/**
 * The providers each commerce slot accepts. A provider that needs an SDK lives in an `@nymbalhq/adapter-*` package the
 * kernel loads only when the config names it; `custom` takes the adapter a project passes to `createApp`.
 */
export const KNOWN_PROVIDERS = {
  payments: ['native', 'stripe', 'custom'],
  email: ['native', 'smtp', 'mailgun', 'custom'],
  reviews: ['native', 'custom'],
  search: ['native', 'custom'],
  analytics: ['native', 'custom'],
  shipping: ['native', 'custom'],
  tax: ['native', 'custom'],
  ai: ['none', 'anthropic', 'custom'],
} as const satisfies Readonly<Record<CommerceSlot, readonly [string, ...string[]]>>
