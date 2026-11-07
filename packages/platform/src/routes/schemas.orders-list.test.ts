import { describe, expect, it } from 'vitest'
import type { ZodTypeAny } from 'zod'
import { jsonSchemaOf } from '../mcp/registry.js'
import { routeSchemas } from './schemas.js'

// AC-5: what `admin_orders_list` tells a model: the shipping postcode and country filters and how they match, the
// count it answers, what `q` does not search, and date bounds whose examples are forms the schema takes.

const ENTRY = routeSchemas['GET /api/admin/orders']!

interface Property {
  description?: string
}

const properties = (): Record<string, Property> =>
  ((jsonSchemaOf(ENTRY) as { properties?: Record<string, Property> }).properties ?? {}) as Record<
    string,
    Property
  >

/** The route's own schema for one query key. */
const schemaOf = (key: string): ZodTypeAny | undefined =>
  (ENTRY.query as unknown as { shape?: Record<string, ZodTypeAny> } | undefined)?.shape?.[key]

/** Every ISO date or date-time literal a text shows, in any precision, with or without a zone. */
const LITERAL = /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g

describe('AC-5: admin_orders_list tells a model its filters and its count', () => {
  it('AC-5: the inputSchema has postcode, described as case and spaces ignored and naming SW10, and country, naming GB; q’s description names postcode and country; the tool’s description names total', () => {
    const props = properties()
    const postcode = props['postcode']?.description ?? ''
    const country = props['country']?.description ?? ''
    const q = props['q']?.description ?? ''

    expect({
      postcode: {
        case: /\bcase\b/i.test(postcode),
        spaces: /\bspaces?\b/i.test(postcode),
        sw10: postcode.includes('SW10'),
      },
      country: { gb: /\bGB\b/.test(country) },
      q: { postcode: /\bpostcode\b/.test(q), country: /\bcountry\b/.test(q) },
      tool: { total: /\btotal\b/.test(ENTRY.description) },
    }).toEqual({
      postcode: { case: true, spaces: true, sw10: true },
      country: { gb: true },
      q: { postcode: true, country: true },
      tool: { total: true },
    })
  })

  it('AC-5: the dateFrom and dateTo descriptions say "seconds", every ISO date or date-time they show parses under that key’s own schema (at least one date-time among them), and 2026-11-01T09:00Z is refused by both', () => {
    const props = properties()
    const shown = (['dateFrom', 'dateTo'] as const).map((key) => {
      const description = props[key]?.description ?? ''
      const literals = [...description.matchAll(LITERAL)].map((m) => m[0])
      const schema = schemaOf(key)!
      return {
        key,
        seconds: /\bseconds\b/.test(description),
        refused: literals.filter((literal) => !schema.safeParse(literal).success),
        dateTimes: literals.filter((literal) => literal.includes('T')).length,
        minutes: schema.safeParse('2026-11-01T09:00Z').success,
      }
    })

    expect(shown.map(({ dateTimes: _, ...rest }) => rest)).toEqual(
      shown.map(({ key }) => ({ key, seconds: true, refused: [], minutes: false })),
    )
    expect(shown.map((s) => s.dateTimes >= 1)).toEqual(shown.map(() => true))
  })
})
