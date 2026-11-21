import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { BASE_CONFIG } from './fixtures/middleware-security.js'
import { nymbalConfigSchema } from './schema.js'

// `security.auth.verification` is `required`, `off` or absent (the store resolves it from its email adapter); any
// other value refuses the config, naming the field, so a typo never leaves a store enumerable without a word.

const FIELD = 'security.auth.verification'

function withVerification(value: unknown): unknown {
  return {
    ...structuredClone(BASE_CONFIG),
    security: { adapter: 'middleware', auth: value === undefined ? {} : { verification: value } },
  }
}

describe('AC-1: the schema takes the three policies and refuses any other', () => {
  // Defect: a misspelt policy is dropped silently, and the store falls back to the default.
  it('AC-1: required, off and absent parse, and the parsed config keeps what was set', () => {
    const parsed = (['required', 'off', undefined] as const).map((value) => {
      const result = nymbalConfigSchema.safeParse(withVerification(value))
      return result.success
        ? (result.data.security.auth as { verification?: unknown }).verification
        : `refused: ${result.error.issues.map((i) => i.message).join('; ')}`
    })

    expect(parsed).toEqual(['required', 'off', undefined])
  })

  it('AC-1: property: any other string is refused with an issue at security.auth.verification', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 12 }).filter((v) => v !== 'required' && v !== 'off'),
        (value) => {
          const result = nymbalConfigSchema.safeParse(withVerification(value))

          expect(result.success, JSON.stringify(value)).toBe(false)
          const paths = result.success ? [] : result.error.issues.map((i) => i.path.join('.'))
          expect(paths, JSON.stringify(value)).toContain(FIELD)
        },
      ),
      { numRuns: 80, examples: [['Required'], ['on'], ['']] },
    )
  })
})
