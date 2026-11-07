import { CUSTOMER_FIELDS, DEFAULT_CUSTOMER_FIELDS, type NymbalConfig } from '@nymbalhq/config'
import type { DiagnosisCheck } from '../diagnose.js'
import { UCP_CAPABILITIES } from './ucp-surface.js'

const NAME = 'agents'

/** The legal pages an agent shows the buyer before it hands over a UCP checkout. */
const REQUIRED_LINKS = ['privacy_policy', 'terms_of_service'] as const

/** Whether `value` is a plain-HTTP origin on a host other than this machine, loopback judged as the trust proxy line
 *  judges it. */
function isPublicHttpOrigin(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return false
  try {
    const { protocol, hostname } = new URL(value.trim())
    if (protocol !== 'http:') return false
    return !(
      hostname === 'localhost' ||
      hostname === '[::1]' ||
      /^127(\.\d{1,3}){3}$/.test(hostname)
    )
  } catch {
    return false
  }
}

function capabilitiesText(): string {
  const { search, lookup, checkout } = UCP_CAPABILITIES
  return [search && 'search', lookup && 'lookup', checkout !== 'none' && `checkout ${checkout}`]
    .filter(Boolean)
    .join(', ')
}

/** The fields in the config's order, joined; `nothing` for none. */
function fieldsText(fields: readonly string[]): string {
  const named = CUSTOMER_FIELDS.filter((field) => fields.includes(field))
  return named.length === 0 ? 'nothing' : named.join(', ')
}

/** What each AI surface is told of a customer: what MCP withholds and what the assistant masks or keeps back. */
function customerFieldsText(agents: NymbalConfig['agents']): string {
  // A config the schema never parsed may leave either out: each reads as its default.
  const withhold = (agents.mcp as Partial<typeof agents.mcp>).withhold ?? DEFAULT_CUSTOMER_FIELDS
  const assistant = (agents as Partial<typeof agents>).assistant
  const told =
    assistant?.customerData === false
      ? 'sends none'
      : `masks ${fieldsText(assistant?.mask ?? DEFAULT_CUSTOMER_FIELDS)}`
  return `customer fields: mcp withholds ${fieldsText(withhold)}; assistant ${told}`
}

/**
 * How ready the agent surfaces are, from the config and the environment alone. UCP checkout advertised without a
 * privacy and a terms link, or on a public plain-HTTP origin, is a warning; it is never `down`, because the surface
 * still serves and doctor's exit code belongs to the checks that stop a store.
 */
export function agentReadiness(config: NymbalConfig, env: NodeJS.ProcessEnv): DiagnosisCheck {
  const { ucp, mcp } = config.agents
  const mcpText = `mcp ${mcp.enabled ? mcp.writes : 'off'}`
  const fields = customerFieldsText(config.agents)
  if (!ucp.enabled) return { name: NAME, status: 'ok', detail: `ucp off; ${mcpText}; ${fields}` }

  const present = new Set(ucp.links.map((link) => link.type))
  const missing = REQUIRED_LINKS.filter((type) => !present.has(type))
  const problems = [
    ...(missing.length > 0
      ? [`ucp checkout names no ${missing.join(' or ')} link: add each to agents.ucp.links`]
      : []),
    ...(isPublicHttpOrigin(env['NYMBAL_PUBLIC_URL'])
      ? ['NYMBAL_PUBLIC_URL is plain http on a public host: serve agents over https']
      : []),
  ]
  if (problems.length > 0) {
    return { name: NAME, status: 'degraded', detail: [...problems, fields].join('; ') }
  }
  return { name: NAME, status: 'ok', detail: `ucp: ${capabilitiesText()}; ${mcpText}; ${fields}` }
}
