import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { kernelConfig } from '../../tests/support/kernel.js'
import { createNativeStubPaymentsAdapter } from '../adapters/payments/native-stub.js'
import * as platform from '../index.js'
import { createLogger } from '../logger.js'
import { resolveAcpSettings } from './acp/settings.js'
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

// AC-8: the same line names the ACP keys the store serves, by name and never by value, immediately before the customer
// fields clause: `acp off`, `acp keys: <names>`, or, on with no key, the refusal boot would start with (degraded).

type AcpConfig = ReturnType<typeof kernelConfig>['agents']['acp']

const ACP_NAME = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,39}$/)
/** Keys marked so a detail can only hold one by printing it. */
const ACP_SECRET = fc.stringMatching(/^[A-Za-z0-9]{32,48}$/).map((s) => `acpk-${s}`)
const namedKeys = fc
  .uniqueArray(fc.record({ name: ACP_NAME, key: ACP_SECRET }), {
    selector: (k) => k.name,
    minLength: 1,
    maxLength: 4,
  })
  .filter((keys) => new Set(keys.map((k) => k.key)).size === keys.length)

/** What boot refuses a keyless ACP with, from boot itself, with no environment to read. */
function bootRefusal(config: ReturnType<typeof kernelConfig>): string {
  const payments = createNativeStubPaymentsAdapter({
    logger: createLogger({ pretty: false, level: 'error' }),
  })
  try {
    resolveAcpSettings(config, payments, {})
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('boot started a keyless ACP')
}

describe('AC-8: the agents line names the ACP keys', () => {
  // Kills: the clause missing, misplaced, or naming the keys out of the config's order.
  it('AC-8: with ucp links in place and keys muse and dots, the line is ok and reads "ucp: search, lookup, checkout handoff; mcp proposal; acp keys: muse, dots; customer fields: mcp withholds …"', () => {
    const base = kernelConfig('sqlite')
    const config = {
      ...base,
      agents: {
        ...base.agents,
        ucp: {
          enabled: true,
          links: REQUIRED.map((type) => ({ type, url: `https://shop.example/${type}` })),
        },
        acp: {
          enabled: true,
          links: [],
          keys: [
            { name: 'muse', key: 'muse-'.padEnd(40, 'm') },
            { name: 'dots', key: 'dots-'.padEnd(40, 'd') },
          ],
        } as AcpConfig,
      },
    }

    const check = agentReadiness(config, {})

    expect(check.status).toBe('ok')
    expect(check.detail.split('; customer fields: ')[0]).toBe(
      'ucp: search, lookup, checkout handoff; mcp proposal; acp keys: muse, dots',
    )
  })

  // Kills: doctor omitting a key the store accepts or naming one it does not read; ok for a store that will not start;
  // NYMBAL_ACP_API_KEY read as a key; a key printed; the ACP clause moving a status it should not.
  it('AC-8: property: on the ok, degraded and ucp off cases the detail holds one ACP clause, immediately before "; customer fields:": "acp off" when off, "acp keys: <names in config order>" when on with keys, and boot’s refusal naming agents.acp.keys when on with none, whatever NYMBAL_ACP_API_KEY holds; keyless is degraded, otherwise the status is the ucp case’s; no key value appears', () => {
    const base = kernelConfig('sqlite')
    const acpState = fc.oneof(
      fc.record({
        enabled: fc.constant(false),
        keys: fc.option(namedKeys, { nil: undefined }),
      }),
      fc.record({ enabled: fc.constant(true), keys: namedKeys }),
      fc.record({
        enabled: fc.constant(true),
        keys: fc.constantFrom<undefined | []>(undefined, []),
      }),
    )
    fc.assert(
      fc.property(
        fc.boolean(),
        links,
        fc.constantFrom(...ORIGINS),
        acpState,
        fc.option(ACP_SECRET, { nil: undefined }),
        (ucpEnabled, ucpLinks, url, acp, envKey) => {
          const config = {
            ...base,
            agents: {
              ...base.agents,
              ucp: { enabled: ucpEnabled, links: ucpLinks },
              acp: {
                enabled: acp.enabled,
                links: [],
                ...(acp.keys !== undefined && { keys: acp.keys }),
              } as AcpConfig,
            },
          }
          const env: NodeJS.ProcessEnv = {
            ...(url !== undefined && { NYMBAL_PUBLIC_URL: url }),
            ...(envKey !== undefined && { NYMBAL_ACP_API_KEY: envKey }),
          }
          const present = new Set(ucpLinks.map((l) => l.type))
          const ucpDegraded =
            ucpEnabled && (REQUIRED.some((type) => !present.has(type)) || url === PUBLIC_HTTP)
          const keyless = acp.enabled && (acp.keys === undefined || acp.keys.length === 0)
          const clause = !acp.enabled
            ? 'acp off'
            : keyless
              ? bootRefusal(config)
              : `acp keys: ${(acp.keys ?? []).map((k) => k.name).join(', ')}`

          const check = agentReadiness(config, env)
          const without = check.detail.replace(`; ${clause}`, '')

          expect({
            status: check.status,
            placed: check.detail.includes(`; ${clause}; customer fields: `),
            others: /acp/i.test(without),
          }).toEqual({
            status: keyless || ucpDegraded ? 'degraded' : 'ok',
            placed: true,
            others: false,
          })
          const secrets = [...(acp.keys ?? []).map((k) => k.key), ...(envKey ? [envKey] : [])]

          expect(!keyless || clause.includes('agents.acp.keys')).toBe(true)
          expect(secrets.filter((secret) => check.detail.includes(secret))).toEqual([])
        },
      ),
      { numRuns: 400 },
    )
  })
})
