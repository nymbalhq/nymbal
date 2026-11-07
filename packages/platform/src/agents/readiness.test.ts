import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { kernelConfig } from '../../tests/support/kernel.js'
import * as platform from '../index.js'
import { agentReadiness } from './readiness.js'

// AC-1: doctor's `agents` line, judged from the config and the environment alone. UCP checkout advertised without a
// privacy and a terms link, or on a public plain-HTTP origin, is a warning; a loopback dev origin and an https origin
// are not; the line is never `down`, so it never fails the run.

const REQUIRED = ['privacy_policy', 'terms_of_service'] as const
const LINK_TYPES = [...REQUIRED, 'refund_policy', 'faq', 'x-not-a-ucp-link'] as const
const PUBLIC_HTTP = 'http://shop.example'
const ORIGINS = [
  undefined,
  '',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
  'http://[::1]:3001',
  'https://shop.example',
  PUBLIC_HTTP,
] as const

/** Link URLs that name no link type and no scheme the detail is judged on. */
const links = fc
  .array(fc.constantFrom(...LINK_TYPES), { maxLength: 7 })
  .map((types) => types.map((type, i) => ({ type, url: `http://legal.example/doc-${i}` })))

describe('AC-1: agentReadiness', () => {
  it('AC-1: is the function @nymbalhq/platform exports', () => {
    expect(platform.agentReadiness).toBe(agentReadiness)
  })

  // Kills: a required link type left unchecked, a loopback dev origin or an https origin that warns, a warning that
  // is `down` (and so fails the run), a detail that names a link that is there or hides one that is not.
  it('AC-1: property: named agents and never down; ucp off is ok "ucp off…"; otherwise degraded iff a privacy_policy or terms_of_service link is missing or NYMBAL_PUBLIC_URL is a public http: origin, the detail naming exactly the missing types, agents.ucp.links when any is missing, and https iff the origin is the public http: one', () => {
    const base = kernelConfig('sqlite')
    fc.assert(
      fc.property(fc.boolean(), links, fc.constantFrom(...ORIGINS), (enabled, ucpLinks, url) => {
        const config = { ...base, agents: { ...base.agents, ucp: { enabled, links: ucpLinks } } }
        const env: NodeJS.ProcessEnv = url === undefined ? {} : { NYMBAL_PUBLIC_URL: url }
        const check = agentReadiness(config, env)

        const present = new Set(ucpLinks.map((l) => l.type))
        const missing = REQUIRED.filter((type) => !present.has(type))
        const insecure = url === PUBLIC_HTTP
        const degraded = enabled && (missing.length > 0 || insecure)
        const expected = !enabled
          ? { name: 'agents', status: 'ok', ucpOff: true }
          : { name: 'agents', status: degraded ? 'degraded' : 'ok', ucpOff: false }
        expect({
          name: check.name,
          status: check.status,
          ucpOff: check.detail.startsWith('ucp off'),
        }).toEqual(expected)

        // What a degraded detail names; an ok detail is held to nothing here.
        const named = degraded
          ? {
              types: REQUIRED.filter((type) => check.detail.includes(type)),
              linksKey: check.detail.includes('agents.ucp.links'),
              https: check.detail.includes('https'),
            }
          : null
        expect(named).toEqual(
          degraded ? { types: missing, linksKey: missing.length > 0, https: insecure } : null,
        )
      }),
      { numRuns: 400 },
    )
  })
})

// AC-10: the same line names what each AI surface is told of a customer: what an admin's MCP client never receives
// (agents.mcp.withhold) and what the admin's assistant sends as placeholders (agents.assistant.mask), or that it sends
// none under customerData false. The clause never changes the line's status.

const FIELDS = ['email', 'phone', 'address', 'postcode', 'name'] as const
const DEFAULT_FIELDS = ['email', 'phone', 'address', 'postcode'] as const

/** The fields, in the config's order, joined as the line prints them; `nothing` for none. */
function named(fields: readonly string[]): string {
  const listed = FIELDS.filter((field) => fields.includes(field))
  return listed.length === 0 ? 'nothing' : listed.join(', ')
}

describe('AC-10: the agents line names what each AI surface withholds', () => {
  it('AC-10: on the default config the detail ends "; customer fields: mcp withholds email, phone, address, postcode; assistant masks email, phone, address, postcode"', () => {
    const clause =
      '; customer fields: mcp withholds email, phone, address, postcode; assistant masks email, phone, address, postcode'

    const { detail } = agentReadiness(kernelConfig('sqlite'), {})

    expect(detail.slice(-clause.length)).toBe(clause)
  })

  // Kills: the withhold list left out, a field printed out of the config's order, `masks` under customerData false,
  // an absent key read as nothing, and a clause that changes the line's status.
  it('AC-10: property: for any agents.mcp.withhold and agents.assistant customerData and mask, each set or left out, on any of the ok, degraded and ucp off cases, the detail ends with exactly "; customer fields: mcp withholds <W>; assistant <A>" and the status is the one the case gives without it', () => {
    const base = kernelConfig('sqlite')
    const { withhold: _withhold, ...mcp } = base.agents.mcp as typeof base.agents.mcp & {
      withhold?: unknown
    }
    const fields = fc.option(fc.shuffledSubarray([...FIELDS]), { nil: undefined })
    fc.assert(
      fc.property(
        fc.boolean(),
        links,
        fc.constantFrom(...ORIGINS),
        fields,
        fc.option(fc.boolean(), { nil: undefined }),
        fields,
        (enabled, ucpLinks, url, withhold, customerData, mask) => {
          const config = {
            ...base,
            agents: {
              ...base.agents,
              ucp: { enabled, links: ucpLinks },
              mcp: { ...mcp, ...(withhold !== undefined && { withhold }) },
              assistant: {
                ...(customerData !== undefined && { customerData }),
                ...(mask !== undefined && { mask }),
              },
            },
          } as typeof base
          const env: NodeJS.ProcessEnv = url === undefined ? {} : { NYMBAL_PUBLIC_URL: url }
          const present = new Set(ucpLinks.map((l) => l.type))
          const degraded =
            enabled && (REQUIRED.some((type) => !present.has(type)) || url === PUBLIC_HTTP)
          const assistant =
            customerData === false ? 'sends none' : `masks ${named(mask ?? DEFAULT_FIELDS)}`
          const clause = `; customer fields: mcp withholds ${named(withhold ?? DEFAULT_FIELDS)}; assistant ${assistant}`

          const check = agentReadiness(config, env)

          expect({ status: check.status, end: check.detail.slice(-clause.length) }).toEqual({
            status: degraded ? 'degraded' : 'ok',
            end: clause,
          })
        },
      ),
      { numRuns: 400 },
    )
  })
})
