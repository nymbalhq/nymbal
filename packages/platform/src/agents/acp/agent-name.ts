const FALLBACK = 'acp'
const MAX_LENGTH = 40

/**
 * The name an ACP agent's carts and orders are labelled with: the User-Agent's first product token, lower-cased and
 * kept to `[a-z0-9._-]`, at most 40 characters (`ChatGPT/2.0 (…)` → `chatgpt`), else `acp`. Any holder of the store's
 * key can send any User-Agent, so the name is a label for the operator and nothing is decided on it.
 */
export function acpAgentName(userAgent: string | string[] | undefined): string {
  const header = Array.isArray(userAgent) ? userAgent[0] : userAgent
  const product = (header ?? '').trim().split(/\s/)[0] ?? ''
  const name = (product.split('/')[0] ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
    .slice(0, MAX_LENGTH)
  return name === '' ? FALLBACK : name
}
