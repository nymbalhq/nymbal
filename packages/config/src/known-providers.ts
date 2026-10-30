import type { CommerceSlot } from '@nymbalhq/types'
import { ADAPTER_CATALOGUE, COMMERCE_SLOTS } from './adapter-names.js'

export type { CommerceSlot }

/**
 * The providers Nymbal ships for each commerce slot, from the catalogue, and `custom`, the adapter a project passes
 * to `createApp`. A slot accepts any provider name; this list gates nothing.
 */
export const KNOWN_PROVIDERS: Readonly<Record<CommerceSlot, readonly string[]>> =
  Object.fromEntries(
    COMMERCE_SLOTS.map((slot) => [slot, [...Object.keys(ADAPTER_CATALOGUE[slot]), 'custom']]),
  ) as unknown as Record<CommerceSlot, readonly string[]>
