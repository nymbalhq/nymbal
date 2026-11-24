import { createHash, timingSafeEqual } from 'node:crypto'
import { ACP_KEY_MIN_LENGTH, type NymbalConfig } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'

/** One assistant's ACP key: its name labels the assistant's orders and audit entries. */
export interface AcpKey {
  name: string
  key: string
}

const sha256 = (text: string) => createHash('sha256').update(text).digest()

/**
 * The keys `agents.acp` serves, in config order, for boot and doctor alike. The schema refuses short and repeated
 * keys; what is left to refuse here is ACP on with none.
 */
export function acpKeys(acp: NymbalConfig['agents']['acp']): AcpKey[] {
  const keys = acp.keys ?? []
  if (keys.length === 0) {
    throw new ConfigError(
      `agents.acp is enabled with no key: name each assistant's key in agents.acp.keys, such as [{ name: 'muse', key: env('NYMBAL_ACP_API_KEY_MUSE') }], each a secret of at least ${ACP_KEY_MIN_LENGTH} characters (\`openssl rand -base64 32\`).`,
      { code: 'config.acp_key_missing' },
    )
  }
  return keys.map(({ name, key }) => ({ name, key }))
}

/** Digests each key once; the returned function compares the bearer's digest with every key's in constant time. */
export function acpKeyMatcher(
  keys: readonly AcpKey[],
): (bearer: string) => { name: string } | null {
  const digests = keys.map(({ name, key }) => ({ name, digest: sha256(key) }))
  return (bearer) => {
    if (bearer === '') return null
    const digest = sha256(bearer)
    let matched: string | null = null
    // Every digest is compared, so the time taken does not say which position matched.
    for (const entry of digests) {
      if (timingSafeEqual(digest, entry.digest)) matched = entry.name
    }
    return matched === null ? null : { name: matched }
  }
}
