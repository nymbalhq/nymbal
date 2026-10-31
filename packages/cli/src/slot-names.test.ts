import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ADAPTER_CATALOGUE, slotFolder, type Slot } from '@nymbalhq/config'
import { slotNamed } from './slot-names.js'

// AC-5: a slot argument is read in either spelling: its config key (`documentStore`) or its folder name
// (`document-store`) gives the key; any other word gives nothing.

const SLOTS = Object.keys(ADAPTER_CATALOGUE) as Slot[]
const SPELLINGS = new Set(SLOTS.flatMap((slot) => [slot, slotFolder(slot)]))

describe('AC-5: slotNamed', () => {
  it('AC-5: each slot key and its folder name map to the key; any other word maps to undefined', () => {
    fc.assert(
      fc.property(fc.constantFrom(...SLOTS), (slot) => {
        expect(slotNamed(slot)).toBe(slot)
        expect(slotNamed(slotFolder(slot))).toBe(slot)
      }),
    )
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.constantFrom(...SLOTS).map((slot) => slotFolder(slot).toUpperCase()),
          fc.constantFrom(...SLOTS).map((slot) => `${slotFolder(slot)}s`),
          fc.constantFrom(...SLOTS).map((slot) => slot.replace(/[A-Z]/, (c) => `_${c}`)),
        ),
        (word) => {
          fc.pre(!SPELLINGS.has(word))
          expect(slotNamed(word)).toBeUndefined()
        },
      ),
      { numRuns: 300 },
    )
  })
})
