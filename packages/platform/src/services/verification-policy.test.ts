import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { resolveVerification } from './index.js'

// The sign-up policy a store runs: the configured `security.auth.verification` when one is set, else `required`
// exactly when its email reaches a mailbox. A store whose mail only reaches the log does not ask for a link nobody can
// open; a store whose mail arrives is not enumerable by default.

describe('AC-1: the policy follows the config, else delivery', () => {
  // Defect: a native store asks for a link that only reaches the log, or a store with mail stays enumerable by default.
  it('AC-1: property: over configured ∈ {required, off, absent} × delivers ∈ {true, false}, resolveVerification is the configured value when set, else required exactly when delivers', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<'required' | 'off' | undefined>('required', 'off', undefined),
        fc.boolean(),
        (configured, delivers) => {
          const resolved = resolveVerification(configured, delivers)

          expect(resolved, `${String(configured)} × ${delivers}`).toBe(
            configured ?? (delivers ? 'required' : 'off'),
          )
        },
      ),
      { numRuns: 60 },
    )
  })
})
