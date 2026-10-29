import type { CommerceSlot } from '@nymbalhq/types'

export type { CommerceSlot }

/**
 * The providers each commerce slot accepts. A provider other than the built-in ones lives in an
 * `@nymbalhq/<slot>-<provider>` package the kernel loads only when the config names it; `custom` takes the adapter a
 * project passes to `createApp`.
 */
export const KNOWN_PROVIDERS = {
  payments: ['native', 'stripe', 'custom'],
  email: ['native', 'smtp', 'mailgun', 'resend', 'ses', 'custom'],
  reviews: ['native', 'custom'],
  search: ['native', 'custom'],
  analytics: ['native', 'custom'],
  shipping: ['native', 'easypost', 'custom'],
  tax: ['native', 'custom'],
  ai: ['none', 'anthropic', 'custom'],
} as const satisfies Readonly<Record<CommerceSlot, readonly [string, ...string[]]>>
