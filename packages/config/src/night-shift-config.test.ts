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

    expect(parsed({})).toEqual({ enabled: true, at: '03:00', ai: { maxInsightsPerNight: 5 } })
    expect(parsed({ nightShift: { enabled: false } })).toEqual({
      enabled: false,
      at: '03:00',
      ai: { maxInsightsPerNight: 5 },
    })
    expect(parsed({ nightShift: { at: '04:15' } })).toEqual({
      enabled: true,
      at: '04:15',
      ai: { maxInsightsPerNight: 5 },
    })
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
          ai: { maxInsightsPerNight: 5 },
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

describe('AC-10: nightShift.ai.maxInsightsPerNight', () => {
  const capOf = (ai: unknown) =>
    nymbalConfigSchema.parse(configWith({ nightShift: { ai } })).nightShift.ai.maxInsightsPerNight

  it('AC-10: the cap is 5 when nightShift.ai is absent or empty, and loads as written at 0 and 20', () => {
    const absent = nymbalConfigSchema.parse(configWith({})).nightShift.ai.maxInsightsPerNight

    expect([absent, capOf({}), capOf({ maxInsightsPerNight: 0 }), capOf({ maxInsightsPerNight: 20 })]).toEqual([
      5, 5, 0, 20,
    ])
  })

  it('AC-10: property: every whole number from 0 to 20 loads as written, and any whole number outside it or any fraction is refused naming nightShift.ai.maxInsightsPerNight', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (n) => {
        expect(capOf({ maxInsightsPerNight: n })).toBe(n)
      }),
    )
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -1_000, max: -1 }),
          fc.integer({ min: 21, max: 1_000 }),
          fc.double({ min: 0, max: 20, noNaN: true }).filter((x) => !Number.isInteger(x)),
        ),
        (n) => {
          expect(refusalOf({ ai: { maxInsightsPerNight: n } })).toContain('nightShift.ai.maxInsightsPerNight')
        },
      ),
    )
  })

  it('AC-10: −1, 21, 2.5 and an unknown key beside the cap are each refused, naming the path', () => {
    const refused = [
      { maxInsightsPerNight: -1 },
      { maxInsightsPerNight: 21 },
      { maxInsightsPerNight: 2.5 },
      { maxInsightsPerNight: 5, maxTokens: 1000 },
    ].map((ai) => refusalOf({ ai }))

    expect(refused).toEqual([
      ['nightShift.ai.maxInsightsPerNight'],
      ['nightShift.ai.maxInsightsPerNight'],
      ['nightShift.ai.maxInsightsPerNight'],
      ['nightShift.ai'],
    ])
  })
})
