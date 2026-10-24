import type { HistoryChange } from '@nymbalhq/types'
import { isDeleted, type Folded } from './fold.js'

type Plain = Record<string, unknown>

function isPlain(value: unknown): value is Plain {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => equal(item, b[i]))
  }
  if (isPlain(a) && isPlain(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].every((key) => equal(a[key], b[key]))
  }
  return false
}

const join = (path: string, key: string) => (path === '' ? key : `${path}.${key}`)

/** Items keyed by a unique string `id` are diffed by it; any other array by index. */
function keyed(items: unknown[]): Map<string, unknown> | null {
  const byId = new Map<string, unknown>()
  for (const item of items) {
    const id = isPlain(item) ? item['id'] : undefined
    if (typeof id !== 'string' || byId.has(id)) return null
    byId.set(id, item)
  }
  return byId
}

function entriesOf(a: unknown[], b: unknown[]): [Map<string, unknown>, Map<string, unknown>] {
  const ka = keyed(a)
  const kb = keyed(b)
  if (ka !== null && kb !== null) return [ka, kb]
  const byIndex = (items: unknown[]) => new Map(items.map((item, i) => [String(i), item]))
  return [byIndex(a), byIndex(b)]
}

function diffMaps(
  path: string,
  a: Map<string, unknown>,
  b: Map<string, unknown>,
  out: HistoryChange[],
): void {
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const from = a.get(key)
    const to = b.get(key)
    if (from !== undefined && to !== undefined) diffValue(join(path, key), from, to, out)
    else if (!equal(from ?? null, to ?? null)) {
      out.push({ path: join(path, key), from: from ?? null, to: to ?? null })
    }
  }
}

function diffValue(path: string, a: unknown, b: unknown, out: HistoryChange[]): void {
  if (isPlain(a) && isPlain(b)) {
    diffMaps(path, new Map(Object.entries(a)), new Map(Object.entries(b)), out)
  } else if (Array.isArray(a) && Array.isArray(b)) {
    diffMaps(path, ...entriesOf(a, b), out)
  } else if (!equal(a, b)) {
    out.push({ path, from: a ?? null, to: b ?? null })
  }
}

/**
 * The fields that differ between two views, as dot paths: array items with an `id` keyed by it
 * (`variants.<id>.stock`), the rest by index. A field one side lacks is null there. Nothing precedes a base view, so
 * a view after none has no changes; a deletion is one change, of `deletedAt`.
 */
export function diffViews(before: Folded, after: Folded): HistoryChange[] {
  if (before === null || after === null || isDeleted(before)) return []
  if (isDeleted(after)) return [{ path: 'deletedAt', from: null, to: after.deletedAt }]
  const out: HistoryChange[] = []
  diffValue('', before, after, out)
  return out
}
