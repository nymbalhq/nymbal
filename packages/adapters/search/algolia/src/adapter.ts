import { randomUUID } from 'node:crypto'
import {
  boundedHealthCheck,
  EVT_PRODUCT_CREATED,
  EVT_PRODUCT_DELETED,
  EVT_PRODUCT_UPDATED,
  ValidationError,
  type Facet,
  type HealthReport,
  type Logger,
  type SearchAdapter,
  type SearchDocument,
  type SearchResult,
} from '@nymbalhq/types'
import {
  createAlgoliaClient,
  indexPath,
  API_ERROR,
  TASK_TIMEOUT,
  UNREACHABLE,
  type AlgoliaClient,
  type AlgoliaConnection,
} from './client.js'
import { queryText, toRecord, type AlgoliaRecord } from './records.js'

export const DEFAULT_INDEX = 'products'
const DEFAULT_LIMIT = 20
/** Algolia's most records in one batch, hits in one page and values in one facet. */
const CHUNK = 1000

/** What makes Algolia match as native search does: every term a prefix, no typos, plurals or stop words. */
export const INDEX_SETTINGS = {
  searchableAttributes: ['_terms'],
  attributesForFaceting: ['categoryIds'],
  queryType: 'prefixAll',
  typoTolerance: false,
  ignorePlurals: false,
  removeStopWords: false,
  advancedSyntax: false,
  paginationLimitedTo: 1000,
} as const

/** Native search's cursor: the page's offset, base64url. */
export function encodeSearchCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url')
}

function decodeSearchCursor(cursor: string): number {
  const text = Buffer.from(cursor, 'base64url').toString('utf8')
  const offset = Number(text)
  if (
    !/^\d+$/.test(text) ||
    !Number.isSafeInteger(offset) ||
    encodeSearchCursor(offset) !== cursor
  ) {
    throw new ValidationError('malformed search cursor')
  }
  return offset
}

/** `filters.categoryIds` (one id or several, any of them), as native reads it. */
function categoryFilter(filters: Record<string, unknown> | undefined): string[] | null {
  const value = filters?.['categoryIds']
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return null
}

const quoted = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`

/** Algolia's `filters` for the categories: any of them. */
function categoryFilters(categories: string[] | null): { filters?: string } {
  if (categories === null) return {}
  return { filters: categories.map((c) => `categoryIds:${quoted(c)}`).join(' OR ') }
}

const compareValues = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

interface Hit {
  objectID: string
  type?: string
  fields?: Record<string, unknown>
}

interface QueryAnswer {
  hits?: Hit[]
  nbHits?: number
  facets?: Record<string, Record<string, number>>
}

/** Unreachable, a 5xx, a 429 or a task Algolia did not publish in time: Algolia is down or busy, not refusing. */
function isOutage(error: unknown): boolean {
  const { code, context } = error as { code?: unknown; context?: { status?: unknown } }
  if (code === UNREACHABLE || code === TASK_TIMEOUT) return true
  const status = context?.status
  return code === API_ERROR && typeof status === 'number' && (status >= 500 || status === 429)
}

export interface AlgoliaSearchAdapterDeps {
  connection: AlgoliaConnection
  logger: Logger
}

export function createAlgoliaSearchAdapter(deps: AlgoliaSearchAdapterDeps): SearchAdapter {
  const { connection, logger } = deps
  const indexName = connection.indexName || DEFAULT_INDEX
  const client: AlgoliaClient = createAlgoliaClient(connection)
  // Set when initialize could not reach Algolia: the settings are written before the next call instead.
  let settingsPending = false

  async function applySettings(): Promise<void> {
    const { taskID } = await client.request<{ taskID: number }>(
      'write',
      'PUT',
      `${indexPath(indexName)}/settings`,
      INDEX_SETTINGS,
    )
    await client.waitForTask(indexName, taskID)
  }

  async function ready(): Promise<void> {
    if (!settingsPending) return
    await applySettings()
    settingsPending = false
  }

  /** Sends `requests` to the index's batch route in chunks, and resolves once every chunk is published. */
  async function batch(index: string, requests: unknown[]): Promise<void> {
    const tasks: number[] = []
    for (let i = 0; i < requests.length; i += CHUNK) {
      const { taskID } = await client.request<{ taskID: number }>(
        'write',
        'POST',
        `${indexPath(index)}/batch`,
        { requests: requests.slice(i, i + CHUNK) },
      )
      tasks.push(taskID)
    }
    for (const taskID of tasks) await client.waitForTask(index, taskID)
  }

  async function operation(
    source: string,
    body: { operation: 'copy' | 'move'; destination: string; scope?: string[] },
  ): Promise<void> {
    const { taskID } = await client.request<{ taskID: number }>(
      'write',
      'POST',
      `${indexPath(source)}/operation`,
      body,
    )
    await client.waitForTask(source, taskID)
  }

  function recordOf(doc: SearchDocument): AlgoliaRecord {
    const { record, dropped } = toRecord(doc)
    if (dropped > 0) {
      logger.warn(
        { productId: doc.id, droppedTerms: dropped },
        `search: product ${doc.id} is over Algolia's 10 KB record limit; its last ${dropped} terms are not searchable`,
      )
    }
    return record
  }

  const upserts = (docs: SearchDocument[]) =>
    docs.map((doc) => ({ action: 'updateObject', body: recordOf(doc) }))

  function query(body: Record<string, unknown>): Promise<QueryAnswer> {
    return client.request<QueryAnswer>('read', 'POST', `${indexPath(indexName)}/query`, body)
  }

  return {
    kind: 'search',
    providerName: 'algolia',
    capabilities: () => ['index', 'search', 'facet'],
    producesEvents: [],
    consumesEvents: [EVT_PRODUCT_CREATED, EVT_PRODUCT_UPDATED, EVT_PRODUCT_DELETED],

    async initialize() {
      try {
        await applySettings()
        settingsPending = false
      } catch (error) {
        // An Algolia outage at boot leaves search down, not the store; a 4xx refusal is a configuration fault.
        if (!isOutage(error)) throw error
        settingsPending = true
        logger.warn(
          { index: indexName, error: (error as Error).message },
          'search: Algolia is unavailable; its index settings are written on the next call',
        )
      }
    },

    healthCheck(): Promise<HealthReport> {
      return boundedHealthCheck(
        async (signal) => {
          const response = await fetch(`${client.readBase}/1/isalive`, { signal })
          return response.ok
            ? { status: 'healthy' }
            : { status: 'down', detail: `Algolia answered /1/isalive with ${response.status}` }
        },
        { redact: [connection.apiKey ?? ''] },
      )
    },

    async index(documents) {
      await ready()
      if (documents.length > 0) await batch(indexName, upserts(documents))
      logger.debug({ count: documents.length }, 'search.index')
      return { indexed: documents.length }
    },

    async remove(ids) {
      await ready()
      if (ids.length === 0) return
      await batch(
        indexName,
        ids.map((objectID) => ({ action: 'deleteObject', body: { objectID } })),
      )
    },

    async replaceAll(documents) {
      await ready()
      // Filled beside the live index and moved over it, so a reader sees the old catalogue or the new one.
      const temporary = `${indexName}_replace_${randomUUID().slice(0, 8)}`
      let count = 0
      try {
        await operation(indexName, {
          operation: 'copy',
          destination: temporary,
          scope: ['settings', 'synonyms', 'rules'],
        })
        let chunk: SearchDocument[] = []
        for await (const doc of documents) {
          chunk.push(doc)
          if (chunk.length === CHUNK) {
            await batch(temporary, upserts(chunk))
            count += chunk.length
            chunk = []
          }
        }
        if (chunk.length > 0) await batch(temporary, upserts(chunk))
        count += chunk.length
        await operation(temporary, { operation: 'move', destination: indexName })
      } catch (error) {
        await client.request('write', 'DELETE', indexPath(temporary)).catch((cleanup: unknown) => {
          logger.warn(
            { index: temporary, error: (cleanup as Error).message },
            'search: the temporary index of a failed replace was not deleted',
          )
        })
        throw error
      }
      logger.debug({ count }, 'search.replaceAll')
    },

    async search(text, params): Promise<SearchResult> {
      const offset = params?.cursor === undefined ? 0 : decodeSearchCursor(params.cursor)
      const requested = params?.limit ?? DEFAULT_LIMIT
      const limit = Number.isFinite(requested)
        ? Math.min(CHUNK, Math.max(1, Math.floor(requested)))
        : DEFAULT_LIMIT
      const q = queryText(text)
      const categories = categoryFilter(params?.filters)
      if (q === '' || categories?.length === 0) return { items: [], total: 0, nextCursor: null }
      await ready()
      const answer = await query({
        query: q,
        offset,
        length: limit,
        attributesToRetrieve: ['type', 'fields'],
        attributesToHighlight: [],
        attributesToSnippet: [],
        ...categoryFilters(categories),
      })
      const items = (answer.hits ?? []).map(
        (hit): SearchDocument => ({
          id: hit.objectID,
          type: hit.type ?? 'product',
          fields: hit.fields ?? {},
        }),
      )
      const total = answer.nbHits ?? 0
      const end = offset + items.length
      return {
        items,
        total,
        nextCursor: items.length > 0 && end < total ? encodeSearchCursor(end) : null,
      }
    },

    async facet(field, params): Promise<Facet> {
      const label = field === 'categoryIds' ? 'Category' : field
      const empty = { field, label, values: [] }
      if (field !== 'categoryIds') return empty
      // No query counts every document, as native does; a query with no terms matches none.
      const q = params?.query === undefined ? '' : queryText(params.query)
      const categories = categoryFilter(params?.filters)
      if ((params?.query !== undefined && q === '') || categories?.length === 0) return empty
      await ready()
      const answer = await query({
        query: q,
        facets: ['categoryIds'],
        maxValuesPerFacet: CHUNK,
        hitsPerPage: 0,
        attributesToRetrieve: [],
        ...categoryFilters(categories),
      })
      const values = Object.entries(answer.facets?.['categoryIds'] ?? {})
        .sort(([a, x], [b, y]) => y - x || compareValues(a, b))
        .map(([value, count]) => ({ value, count }))
      return {
        field,
        label,
        values: params?.limit === undefined ? values : values.slice(0, params.limit),
      }
    },
  }
}
