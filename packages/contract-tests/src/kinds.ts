import type { Slot } from '@nymbalhq/types'

// Its own entry (`@nymbalhq/contract-tests/kinds`), free of vitest: the CLI reads it in its own process, where
// importing vitest outside a test run throws.

/** The kinds `contractSuites` has a suite for. */
export const CONTRACT_KINDS = [
  'payments',
  'email',
  'reviews',
  'search',
  'analytics',
  'shipping',
  'tax',
  'documentStore',
  'eventBus',
  'media',
] as const satisfies readonly Slot[]
