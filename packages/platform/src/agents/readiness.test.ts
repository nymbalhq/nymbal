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
