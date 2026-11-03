import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { NymbalError } from '@nymbalhq/types'
import { renderError } from './envelope.js'

// A 500 never shows text from outside Nymbal's own errors: a driver's or runtime's message stays in the log, and the
// caller reads `internal` / `Internal server error`. A NymbalError keeps its own code and message.

const INTERNAL = { code: 'internal', message: 'Internal server error' }

interface Rendered {
  status: number
  body: { error?: { code: string; message: string } }
}

describe('AC-18: renderError hides what is not a NymbalError', () => {
  it('AC-18: a driver error, and any plain Error or thrown value whatever its text, answers 500 { code: internal, message: Internal server error }, while a NymbalError keeps its own code and message', () => {
    const driver = renderError(new Error('UNIQUE constraint failed: customers.email')) as Rendered
    expect({ status: driver.status, error: driver.body.error }).toEqual({
      status: 500,
      error: INTERNAL,
    })

    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.boolean(), (text, asError) => {
        const rendered = renderError(asError ? new Error(text) : text) as Rendered
        expect({ status: rendered.status, error: rendered.body.error }).toEqual({
          status: 500,
          error: INTERNAL,
        })
      }),
      { numRuns: 200 },
    )

    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,8}\.[a-z_]{1,16}$/),
        fc.string({ minLength: 1, maxLength: 60 }),
        (code, message) => {
          const error = (renderError(new NymbalError(code, message)) as Rendered).body.error
          expect({ code: error?.code, message: error?.message }).toEqual({ code, message })
        },
      ),
      { numRuns: 200 },
    )
  })
})
