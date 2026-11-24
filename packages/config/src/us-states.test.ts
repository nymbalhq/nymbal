import * as types from '@nymbalhq/types'
import { describe, expect, it } from 'vitest'
import { US_STATES } from './index.js'

// The US states live in @nymbalhq/types, where the address form reads them; the config keeps exporting the same
// object, so the tax table and the form can never hold two lists that drift.

/** The list @nymbalhq/types exports. */
function typesStates(): Readonly<Record<string, string>> | undefined {
  return (types as unknown as { US_STATES?: Readonly<Record<string, string>> }).US_STATES
}

describe('US_STATES', () => {
  it("AC-1: @nymbalhq/config's US_STATES is the very object @nymbalhq/types exports, the 50 states and DC", () => {
    expect(US_STATES, 'one object, re-exported').toBe(typesStates())
    expect(Object.keys(US_STATES)).toHaveLength(51)
  })
})
