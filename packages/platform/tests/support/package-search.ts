import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import type { NymbalConfig } from '@nymbalhq/config'
import type { RecordedRequest } from '../../../adapters/search/algolia/src/tests/fake-algolia.js'

// What the tests of a search slot on a package share: where the Algolia package and a third party's fixture package
// live, a kernel config with another search block, a kernel built with a store project as the working directory (the
// kernel imports a slot's package from the project root, `process.cwd()`), the requests that write records to an
// Algolia index, and the event log's rows as a second connection reads them.

/** The workspace directory of @nymbalhq/search-algolia: a store installs it, the tests link it. */
export const ALGOLIA_PACKAGE_DIR = fileURLToPath(
  new URL('../../../adapters/search/algolia', import.meta.url),
)

/** A third party's search package, `@acme/nymbal-search`, with one declared secret (ACME_SEARCH_KEY). */
export const ACME_SEARCH_FIXTURE = fileURLToPath(
  new URL('../integration/fixtures/package-search/acme-search.mjs', import.meta.url),
)

export interface AcmeSearchState {
  /** Each write the fixture was asked for: [method, ids]. */
  writes: Array<[string, string[]]>
}

export function acmeSearchState(): AcmeSearchState {
  const g = globalThis as { __acmeSearch?: AcmeSearchState & { docs: Map<string, unknown> } }
  g.__acmeSearch ??= { writes: [], docs: new Map() }
  return g.__acmeSearch
}

/** The config with `commerce.search` set to `block`. */
export const withSearch =
  (block: Record<string, unknown>) =>
  (config: NymbalConfig): NymbalConfig =>
    ({
      ...config,
      commerce: { ...config.commerce, search: block },
    }) as NymbalConfig

/** Runs `fn` with `dir` as the working directory, as a store's process runs in its project. */
export async function inProject<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.cwd()
  process.chdir(dir)
  try {
    return await fn()
  } finally {
    process.chdir(before)
  }
}

/** Whether a request to the fake Algolia writes records: a batch, a single object, a clear, a copy or move, a delete. */
export function isRecordWrite(r: Pick<RecordedRequest, 'method' | 'path'>): boolean {
  if (r.path.endsWith('/settings')) return false
  if (r.method === 'POST')
    return /\/(batch|operation|clear)$/.test(r.path) || /^\/1\/indexes\/[^/]+$/.test(r.path)
  return r.method === 'PUT' || r.method === 'DELETE'
}

export interface EventRow {
  seq: number
  type: string
  attempts: number
  delivered_at: string | null
  dead_at: string | null
}

/** The event log's rows after `afterSeq`, on a connection of its own. */
export function eventRows(sqlitePath: string, afterSeq = 0): EventRow[] {
  const db = new Database(sqlitePath, { readonly: true })
  try {
    db.pragma('busy_timeout = 5000')
    return db
      .prepare(
        'SELECT seq, type, attempts, delivered_at, dead_at FROM events WHERE seq > ? ORDER BY seq',
      )
      .all(afterSeq) as EventRow[]
  } finally {
    db.close()
  }
}

export function lastSeq(sqlitePath: string): number {
  const rows = eventRows(sqlitePath)
  return rows.length === 0 ? 0 : rows[rows.length - 1]!.seq
}
