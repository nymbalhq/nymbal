import type { AdapterSetting } from '@nymbalhq/types'

/** A settings row as the fill uses it: decrypted, or a non-secret's plain value. */
export interface SettingValue {
  slot: string
  path: string
  value: string
}

export type SettingSource = 'config' | 'env' | 'settings'

/** The value at a dot path of `source`, or `undefined`. */
export function getPath(source: unknown, path: string): unknown {
  let at: unknown = source
  for (const key of path.split('.')) {
    if (typeof at !== 'object' || at === null) return undefined
    at = (at as Record<string, unknown>)[key]
  }
  return at
}

/** `undefined`, `null` and the empty string leave a field to the next source: `.env.example` writes `KEY=`. */
export function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

/** A copy of `target` with `value` at `path`, every object on the way copied rather than changed. */
function withPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = path.split('.') as [string, ...string[]]
  if (rest.length === 0) return { ...target, [head]: value }
  const inner = target[head]
  const next =
    typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? (inner as Record<string, unknown>)
      : {}
  return { ...target, [head]: withPath(next, rest.join('.'), value) }
}

/** Where a declared field comes from: the block, its env, a row, or nowhere. */
export function sourceOf(
  block: Record<string, unknown>,
  decl: AdapterSetting,
  env: NodeJS.ProcessEnv,
  hasRow: boolean,
): SettingSource | null {
  if (isPresent(getPath(block, decl.path))) return 'config'
  if (decl.env !== undefined && isPresent(env[decl.env])) return 'env'
  return hasRow ? 'settings' : null
}

/**
 * The slot's config block with each declared path resolved as block, then its declared env, then this slot's row
 * (the deploy always wins). Nothing undeclared is added and `block` is not changed.
 */
export function fillFromSettings(
  slot: string,
  block: Record<string, unknown>,
  declared: readonly AdapterSetting[],
  rows: readonly SettingValue[],
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  let out = block
  for (const decl of declared) {
    if (isPresent(getPath(block, decl.path))) continue
    const fromEnv = decl.env === undefined ? undefined : env[decl.env]
    const value = isPresent(fromEnv)
      ? fromEnv
      : rows.find((row) => row.slot === slot && row.path === decl.path)?.value
    if (value !== undefined) out = withPath(out, decl.path, value)
  }
  return out
}

/** The declared secrets a slot cannot run without that `config` still lacks. */
export function missingSecrets(
  config: Record<string, unknown>,
  declared: readonly AdapterSetting[],
): string[] {
  return declared
    .filter(
      (decl) => decl.secret && decl.optional !== true && !isPresent(getPath(config, decl.path)),
    )
    .map((decl) => decl.path)
}
