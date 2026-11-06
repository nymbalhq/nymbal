function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function profileHost(meta: unknown): string | undefined {
  if (!isObject(meta)) return undefined
  const agent = meta['ucp-agent']
  if (!isObject(agent)) return undefined
  const profile = agent['profile']
  if (typeof profile !== 'string' || !URL.canParse(profile)) return undefined
  const { host } = new URL(profile)
  return host === '' ? undefined : host
}

/**
 * The name a UCP call travels under: the host of the platform profile its `meta` names, else the MCP client's name,
 * else `mcp-client`. Both arguments come from the agent, so anything malformed falls through rather than throws.
 */
export function agentNameOf(meta: unknown, clientInfo: unknown): string {
  const host = profileHost(meta)
  if (host !== undefined) return host
  const name = isObject(clientInfo) ? clientInfo['name'] : undefined
  return typeof name === 'string' && name !== '' ? name : 'mcp-client'
}
