import type { NymbalConfig } from './schema.js'

export const PUBLIC_URL_ENV = 'NYMBAL_PUBLIC_URL'

/**
 * Whether the cookies the API sets carry `Secure`: exactly when the store's public origin is https, that origin being
 * NYMBAL_PUBLIC_URL when set, else `store.url`. With neither, production's. NODE_ENV alone is not enough: a staging
 * store served over https would send its session cookies over http too.
 */
export function secureCookies(
  config: Pick<NymbalConfig, 'store'>,
  env: Record<string, string | undefined>,
): boolean {
  const fromEnv = env[PUBLIC_URL_ENV]?.trim()
  const origin = fromEnv !== undefined && fromEnv !== '' ? fromEnv : config.store.url
  if (origin === undefined) return env['NODE_ENV'] === 'production'
  return /^https:/i.test(origin)
}
