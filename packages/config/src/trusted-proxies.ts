import { isIP } from 'node:net'
import proxyAddr from '@fastify/proxy-addr'
import {
  ConfigError,
  type NetworkSource,
  type ResolvedNetwork,
  type SecurityNetwork,
} from '@nymbalhq/types'
import type { NymbalConfig } from './schema.js'

export const TRUSTED_PROXIES_ENV = 'NYMBAL_TRUSTED_PROXIES'
export const CLIENT_IP_HEADER_ENV = 'NYMBAL_CLIENT_IP_HEADER'
const REMOVED_HOPS_ENV = 'NYMBAL_TRUST_PROXY_HOPS'
const LIST_KEY = 'http.trustedProxies'
const HEADER_KEY = 'http.clientIpHeader'
const DEFAULT_LIST = ['loopback']

const PRESETS = ['loopback', 'linklocal', 'uniquelocal'] as const
const PRESET_MATCHERS = PRESETS.map((preset) => [preset, proxyAddr.compile(preset)] as const)

/** An RFC 9110 field name. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
/** Chains, which the trusted list walks: never a single client address. */
const CHAIN_HEADERS = ['x-forwarded-for', 'forwarded']

/**
 * What is wrong with one trusted-proxy entry, by proxy-addr's own reading of it (the reading Fastify applies when it is
 * built): `everyone` for a prefix of 0 or an IPv4-mapped range of /96 or wider (at /96 proxy-addr matches every IPv4
 * peer against it), `invalid` for anything else it refuses, `null` when it compiles.
 */
export function trustedProxyProblem(entry: string): 'invalid' | 'everyone' | null {
  if (compiles(entry)) return mappedEveryIpv4(entry) ? 'everyone' : null
  const slash = entry.lastIndexOf('/')
  if (slash < 0) return 'invalid'
  const prefix = entry.slice(slash + 1)
  const zero = /^0+$/.test(prefix) || prefix === '0.0.0.0'
  return zero && isIP(entry.slice(0, slash)) !== 0 ? 'everyone' : 'invalid'
}

function mappedEveryIpv4(entry: string): boolean {
  const slash = entry.lastIndexOf('/')
  if (slash < 0 || Number(entry.slice(slash + 1)) > 96) return false
  const address = entry.slice(0, slash).split('%')[0]!
  if (isIP(address) !== 6) return false
  // The WHATWG form of any IPv4-mapped address is ::ffff:<hextet>:<hextet>.
  return /^\[::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}\]$/.test(new URL(`http://[${address}]`).hostname)
}

function compiles(entry: string): boolean {
  try {
    proxyAddr.compile([entry])
    return true
  } catch {
    return false
  }
}

export function trustedProxyMessage(
  entry: string,
  source: string,
  problem: 'invalid' | 'everyone',
): string {
  return problem === 'everyone'
    ? `${source} entry '${entry}' trusts every address, so any client could choose its own; list the proxies in front instead, such as loopback or uniquelocal`
    : `${source} entry '${entry}' is not a proxy address: list loopback, linklocal, uniquelocal, an IP address or a CIDR such as 10.0.0.0/8`
}

/** Why a client-address header name cannot be used, or null. */
export function clientIpHeaderProblem(name: string): string | null {
  if (!TOKEN.test(name)) return 'is not an HTTP header name'
  if (CHAIN_HEADERS.includes(name.toLowerCase())) {
    return 'is a chain of addresses, which the trusted proxy list already reads; name a header that holds one client address, such as True-Client-IP'
  }
  return null
}

function sourceLabel(source: NetworkSource): string {
  return source.kind === 'adapter' ? `adapter ${source.name}` : source.name
}

/** A variable's value, or undefined when it is unset or blank. */
function fromEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

function resolveList(
  config: NymbalConfig,
  env: NodeJS.ProcessEnv,
  contribution: { adapter: string; network: SecurityNetwork } | undefined,
): { list: string[]; source: NetworkSource } {
  const variable = fromEnv(env, TRUSTED_PROXIES_ENV)
    ?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  if (variable !== undefined && variable.length > 0) {
    return { list: variable, source: { kind: 'env', name: TRUSTED_PROXIES_ENV } }
  }
  if (config.http.trustedProxies !== undefined) {
    return { list: config.http.trustedProxies, source: { kind: 'config', name: LIST_KEY } }
  }
  if (contribution?.network.trustedProxies !== undefined) {
    return {
      list: contribution.network.trustedProxies,
      source: { kind: 'adapter', name: contribution.adapter },
    }
  }
  return { list: [...DEFAULT_LIST], source: { kind: 'default', name: 'default' } }
}

function resolveHeader(
  config: NymbalConfig,
  env: NodeJS.ProcessEnv,
  contribution: { adapter: string; network: SecurityNetwork } | undefined,
): { header: string; source: NetworkSource } | undefined {
  const variable = fromEnv(env, CLIENT_IP_HEADER_ENV)
  if (variable !== undefined) {
    return { header: variable, source: { kind: 'env', name: CLIENT_IP_HEADER_ENV } }
  }
  if (config.http.clientIpHeader !== undefined) {
    return { header: config.http.clientIpHeader, source: { kind: 'config', name: HEADER_KEY } }
  }
  if (contribution?.network.clientIpHeader !== undefined) {
    return {
      header: contribution.network.clientIpHeader,
      source: { kind: 'adapter', name: contribution.adapter },
    }
  }
  return undefined
}

/**
 * The proxies whose forwarded client address the API believes, and the one client-address header it reads from them.
 * Each resolves on its own: its variable, else its config key, else the security adapter's contribution, else the
 * default (`loopback`; no header). Every value is checked as Fastify will read it, so a list this returns cannot fail the
 * server's construction; trusting every address is refused, as is the removed hop count.
 */
export function resolveTrustedProxies(
  config: NymbalConfig,
  env: NodeJS.ProcessEnv,
  contribution?: { adapter: string; network: SecurityNetwork },
): ResolvedNetwork {
  if (fromEnv(env, REMOVED_HOPS_ENV) !== undefined) {
    throw new ConfigError(
      `${REMOVED_HOPS_ENV} was removed: list the proxies in front in ${TRUSTED_PROXIES_ENV} instead, such as loopback or uniquelocal`,
      { code: 'config.trust_proxy_hops_removed', context: { variable: REMOVED_HOPS_ENV } },
    )
  }

  const { list, source } = resolveList(config, env, contribution)
  for (const entry of list) {
    const problem = trustedProxyProblem(entry)
    if (problem === null) continue
    const label = sourceLabel(source)
    throw new ConfigError(trustedProxyMessage(entry, label, problem), {
      code:
        problem === 'everyone'
          ? 'config.trusted_proxies_everyone'
          : 'config.trusted_proxies_invalid',
      context: { entry, source: label },
    })
  }

  const header = resolveHeader(config, env, contribution)
  if (header !== undefined) {
    const problem = clientIpHeaderProblem(header.header)
    if (problem !== null) {
      const label = sourceLabel(header.source)
      throw new ConfigError(`${label} '${header.header}' ${problem}`, {
        code: 'config.client_ip_header_invalid',
        context: { header: header.header, source: label },
      })
    }
  }

  return {
    trustedProxies: list,
    trustedProxiesSource: source,
    ...(header !== undefined && {
      clientIpHeader: header.header,
      clientIpHeaderSource: header.source,
    }),
    clientIpRequiresLock:
      header?.source.kind === 'adapter' && contribution?.network.clientIpRequiresLock === true,
  }
}

/** The preset that holds `address` (an IPv4-mapped address by its IPv4 form), else the address itself. */
export function trustSuggestion(address: string): string {
  for (const [preset, holds] of PRESET_MATCHERS) if (holds(address, 0)) return preset
  return address
}
