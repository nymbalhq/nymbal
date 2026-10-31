import { ADAPTER_CATALOGUE, slotFolder } from '@nymbalhq/config'
import type { Slot } from '@nymbalhq/types'

const SLOTS = Object.keys(ADAPTER_CATALOGUE) as Slot[]

/** The slot `word` spells, as its folder name (`document-store`) or, silently, its config key (`documentStore`). */
export function slotNamed(word: string): Slot | undefined {
  return SLOTS.find((slot) => slot === word || slotFolder(slot) === word)
}
