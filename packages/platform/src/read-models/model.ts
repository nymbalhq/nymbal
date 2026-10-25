import type { NymbalConfig } from '@nymbalhq/config'
import type { DocumentStoreAdapter, Logger, SearchAdapter } from '@nymbalhq/types'
import type { CommandStore, ReadTx } from '../db/command-store.js'
import type { DerivedHandler } from '../handlers/derived.js'
import type { KeysetPage, Repositories } from '../repositories/index.js'
import type { LoggedEvent } from '../repositories/event-log.js'
import type { DocumentWrite } from './builders.js'

export type ReadModelName = 'catalogue' | 'orders' | 'customers' | 'search' | 'recently-viewed'

/** The pseudo-collection a search model's writes go to: the search adapter, not the document store. */
export const SEARCH_INDEX = 'index'

export interface RebuildDeps {
  config: NymbalConfig
  store: CommandStore
  repos: Repositories
  /** Where the document models are rebuilt and caught up. */
  documentStore: DocumentStoreAdapter
  /** Where the search model is rebuilt and caught up; the search model cannot be rebuilt without it. */
  search?: SearchAdapter
  logger: Logger
  /** Rows per page read from the command store. */
  pageSize?: number
  /** Called before each page is read. */
  onPage?: (page: { model: ReadModelName; table: string; page: number }) => void | Promise<void>
}

/** What a rebuilder reads with: the command store in pages, each page a read of its own. */
export interface RebuildContext {
  deps: RebuildDeps
  pages<T extends { id: string }>(
    table: string,
    read: (tx: ReadTx, page: KeysetPage) => Promise<T[]>,
  ): AsyncIterable<T[]>
  /**
   * The logged events of `types`, in seq pages, each page a read of its own (`onPage` names the table `events`). A model
   * that reads them is caught up only with events above the last one it read: re-applying one it already folded
   * would fold it twice. The bound is per model, not per collection: a model that reads both `pages()` and `events()`
   * would skip catch-up for the collections it builds from tables.
   */
  events(types: readonly string[]): AsyncIterable<LoggedEvent[]>
}

export interface ReadModel {
  name: ReadModelName
  /** Where its documents go: document-store collections, or the search adapter. */
  target: 'documents' | 'search'
  /** The document-store collections it owns; the search model owns none. */
  collections: readonly string[]
  /** Every document of the model, from the authoritative tables. A search model writes to `SEARCH_INDEX`. */
  rebuild(ctx: RebuildContext): AsyncIterable<DocumentWrite>
  /** The live projections that keep the model, bound to `deps`' document store and search adapter. */
  handlers(deps: RebuildDeps): DerivedHandler[]
}

/** The search adapter of `deps`, which the search model needs. */
export function searchOf(deps: RebuildDeps): SearchAdapter {
  if (deps.search === undefined) throw new Error('the search read model needs a search adapter')
  return deps.search
}
