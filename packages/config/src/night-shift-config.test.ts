import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema } from './index.js'

// `nightShift` in nymbal.config.ts: on at 03:00 store time unless told otherwise, and a time or key that cannot be
// meant is refused at load rather than leaving the night silently off.

function configWith(more: Record<string, unknown>) {
  return {
    store: { name: 'Test Store', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware' },
    commerce: {
      payments: { provider: 'native' },
      email: { provider: 'native' },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3001 },
    deployment: { strategy: 'standard' },
    ...more,
  }
}

/** The paths of the issues a parse of `nightShift` raised, or null when it loaded. */
function refusalOf(nightShift: unknown): string[] | null {
  const result = nymbalConfigSchema.safeParse(configWith({ nightShift }))
  return result.success ? null : result.error.issues.map((issue) => issue.path.join('.'))
}

const two = (n: number) => String(n).padStart(2, '0')

describe('AC-2: nightShift config', () => {
  it('AC-2: without a nightShift block the night is on at 03:00, and a block that sets only one key keeps the other default', () => {
    const parsed = (more: Record<string, unknown>) => nymbalConfigSchema.parse(configWith(more)).nightShift

    expect(parsed({})).toEqual({ enabled: true, at: '03:00' })
    expect(parsed({ nightShift: { enabled: false } })).toEqual({ enabled: false, at: '03:00' })
    expect(parsed({ nightShift: { at: '04:15' } })).toEqual({ enabled: true, at: '04:15' })
  })

  it('AC-2: 24:00, 23:58, 3:00, 03:60 and an unknown key under nightShift are each refused, naming nightShift', () => {
    const refused = [
      { at: '24:00' },
      { at: '23:58' },
      { at: '3:00' },
      { at: '03:60' },
      { at: '03:00', suppressDays: 7 },
    ].map(refusalOf)

    expect(refused.map((paths) => paths?.some((p) => p.startsWith('nightShift')))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ])
  })

  it('AC-2: property: every HH:MM from 00:00 to 22:59 loads as written, and every hour 23–99 or minute 60–99 is refused', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 22 }), fc.integer({ min: 0, max: 59 }), (h, m) => {
        const time = `${two(h)}:${two(m)}`
        expect(nymbalConfigSchema.parse(configWith({ nightShift: { at: time } })).nightShift).toEqual({
          enabled: true,
          at: time,
        })
      }),
    )
    fc.assert(
      fc.property(
        fc.oneof(
          fc.tuple(fc.integer({ min: 23, max: 99 }), fc.integer({ min: 0, max: 59 })),
          fc.tuple(fc.integer({ min: 0, max: 22 }), fc.integer({ min: 60, max: 99 })),
        ),
        ([h, m]) => {
          expect(refusalOf({ at: `${two(h)}:${two(m)}` })).toContain('nightShift.at')
        },
      ),
    )
  })
})
