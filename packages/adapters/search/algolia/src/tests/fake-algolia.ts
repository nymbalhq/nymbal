import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

// Algolia's search REST API as the adapter uses it, in process on 127.0.0.1 and port 0. `host` stands for both the
// write host (https://<appId>.algolia.net) and the read host (https://<appId>-dsn.algolia.net). It serves:
//   GET    /1/isalive                               the health endpoint, no key needed
//   GET    /1/indexes                               the indexes, as { items: [{ name, entries }] }
//   POST   /1/indexes/{index}/batch                 addObject, updateObject, partialUpdateObject(NoCreate),
//                                                   deleteObject and clear, as one task
//   POST   /1/indexes/*/batch                       the same, each request naming its indexName
//   GET    /1/indexes/{index}/task/{id}, /1/task/{id}  { status: 'published' | 'notPublished', pendingTask }
//   POST   /1/indexes/{index}/query                 search: query, filters, facetFilters, facets, offset and length,
//                                                   page and hitsPerPage, attributesToRetrieve, as JSON or `params`
//   POST   /1/indexes/*/queries                     several searches
//   GET    /1/indexes/{index}/settings, PUT ...     the settings (PUT merges the keys it is given, as one task)
//   POST   /1/indexes/{index}/operation             copy (whole, or `scope: ['settings']`) and move, as one task
//   POST   /1/indexes/{index}/clear, DELETE /1/indexes/{index}, PUT|DELETE /1/indexes/{index}/{objectID}
// A request without both X-Algolia-Application-Id and X-Algolia-API-Key, or with other values than the fake was
// started with, is Algolia's 403. A write is a task: it is applied when the task is published, so a read before that
// does not see it. A task answers `notPublished` to its first status read and is published by its second (or a second
// after it was made); publishing one publishes every older task first, in order.
// Matching is Algolia's as the index's settings configure it, with Algolia's defaults where a setting is unset: every
// attribute searchable, `prefixLast`, typo tolerance on (one typo from 4 letters, two from 8), and `filters`, facets
// and facet filters only on `attributesForFaceting`. Words are runs of letters and digits after lowercasing and
// removing accents. Every query word must match (no word is dropped when nothing matches). Hits come in the order the
// records were first written.
// It refuses, with Algolia's 400, a query longer than 512 bytes and a batch holding a record whose JSON is longer than
// 10 KB, so an adapter that breaks either limit fails here.
// Readings it takes from Algolia's documentation but has not confirmed against a live app (the contract run against a
// real app checks them, `tests/contracts/algolia-search.test.ts`):
//   - the 512-byte query limit, counted in UTF-8 bytes of `query`, and the 10 KB record limit, counted as 10,000 bytes
//     of the record's JSON; the wording of both refusals;
//   - `queryType: 'prefixAll'` treats a word of digits only as a prefix, as it does a word of letters;
//   - `nbHits` and facet counts are exact at this size (no approximation below a few thousand records);
//   - a published task is visible on the -dsn read host at once;
//   - `filters` or `facetFilters` on an attribute outside `attributesForFaceting` match nothing (not a 400);
//   - a task is found by its id on any index's task route, and its first status read says `notPublished`.

/** Algolia's limit on `query`, in bytes. */
export const QUERY_LIMIT_BYTES = 512
/** Algolia's free-plan limit on one record, in bytes of its JSON. */
export const RECORD_LIMIT_BYTES = 10_000

export type AlgoliaRecord = Record<string, unknown> & { objectID: string }

export interface RecordedRequest {
  method: string
  /** The path, without the query string: `/1/indexes/products/batch`. */
  path: string
  /** The index the path names, decoded; null for `*` and the routes that name none. */
  index: string | null
  body: unknown
  status: number
}

export interface FakeAlgoliaOptions {
  /** The application id the fake accepts; any when unset. */
  appId?: string
  /** The API key the fake accepts; any when unset. */
  apiKey?: string
}

export type RequestHook = (request: {
  method: string
  path: string
  index: string | null
  body: unknown
}) => Promise<void> | void

export interface FakeAlgolia {
  /** What the adapter's `host` is set to: `http://127.0.0.1:<port>`. */
  readonly host: string
  /** Every request so far, in order, with the status it got. */
  readonly requests: RecordedRequest[]
  /** The index's published records, in the order they were first written; none for an index that does not exist. */
  records(index: string): AlgoliaRecord[]
  /** The settings written to the index (no defaults), or undefined for an index that does not exist. */
  settings(index: string): Record<string, unknown> | undefined
  /** The names of the indexes that exist. */
  indexes(): string[]
  /** The dashboard's import: writes `records` to the index at once, unchecked. */
  load(index: string, records: AlgoliaRecord[]): void
  /** Awaited before each authorised request is handled; null removes it. */
  intercept(hook: RequestHook | null): void
  close(): Promise<void>
}

interface Index {
  records: Map<string, AlgoliaRecord>
  settings: Record<string, unknown>
}

interface Task {
  id: number
  polls: number
  published: boolean
  apply: () => void
  timer: ReturnType<typeof setTimeout>
}

type Answer = { status: number; body: unknown }

const DEFAULTS: Readonly<Record<string, unknown>> = {
  searchableAttributes: null,
  attributesForFaceting: null,
  queryType: 'prefixLast',
  typoTolerance: true,
  minWordSizefor1Typo: 4,
  minWordSizefor2Typos: 8,
  ignorePlurals: false,
  removeStopWords: false,
  advancedSyntax: false,
  paginationLimitedTo: 1000,
  hitsPerPage: 20,
  maxValuesPerFacet: 100,
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
])

const fail = (status: number, message: string): Answer => ({ status, body: { message, status } })
const clone = <T>(value: T): T => structuredClone(value)

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Algolia's words: runs of letters and digits, lowercased, accents removed. */
function wordsOf(text: string): string[] {
  return (
    text
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
}

/** Optimal string alignment distance. */
function typos(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1)
      }
      d[i]![j] = best
    }
  }
  return d[a.length]![b.length]!
}

const singular = (word: string): string =>
  word.length > 1 && word.endsWith('s') ? word.slice(0, -1) : word

/** An attribute name without Algolia's modifiers: `unordered(x)`, `searchable(x)`, `filterOnly(x)`, `afterDistinct(x)`. */
function bare(attribute: string): string {
  return /^\w+\((.+)\)$/.exec(attribute.trim())?.[1] ?? attribute.trim()
}

function valueAt(record: Record<string, unknown>, path: string): unknown {
  let at: unknown = record
  for (const part of path.split('.')) {
    if (typeof at !== 'object' || at === null) return undefined
    at = (at as Record<string, unknown>)[part]
  }
  return at
}

function textsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)]
  if (Array.isArray(value)) return value.flatMap(textsOf)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(textsOf)
  return []
}

function facetValues(record: AlgoliaRecord, attribute: string): string[] {
  const value = valueAt(record, attribute)
  const all = Array.isArray(value) ? value : value === undefined ? [] : [value]
  return [...new Set(all.filter((v) => typeof v === 'string' || typeof v === 'number').map(String))]
}

type Filter = (record: AlgoliaRecord) => boolean

/** `filters`: `attr:value` terms (values bare or quoted) joined by OR and AND, NOT, parentheses. */
function parseFilters(text: string, faceted: (attribute: string) => boolean): Filter {
  const tokens =
    text.match(/\(|\)|[^\s()"']*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|[^\s()"']+/g) ?? []
  let at = 0
  const peek = () => tokens[at]
  const unquote = (v: string) =>
    /^(["']).*\1$/.test(v) ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v
  const term = (): Filter => {
    const token = tokens[at++]
    if (token === undefined) throw new Error('filters: unexpected end')
    if (token === 'NOT') {
      const inner = term()
      return (r) => !inner(r)
    }
    if (token === '(') {
      const inner = or()
      if (tokens[at++] !== ')') throw new Error('filters: missing )')
      return inner
    }
    const colon = token.indexOf(':')
    if (colon <= 0) throw new Error(`filters: unexpected token ${token}`)
    const attribute = unquote(token.slice(0, colon))
    const value = unquote(token.slice(colon + 1))
    if (!faceted(attribute)) return () => false
    return (r) => facetValues(r, attribute).includes(value)
  }
  const or = (): Filter => {
    const parts = [and()]
    while (peek() === 'OR') {
      at++
      parts.push(and())
    }
    return (r) => parts.some((p) => p(r))
  }
  const and = (): Filter => {
    const parts = [term()]
    while (peek() === 'AND') {
      at++
      parts.push(term())
    }
    return (r) => parts.every((p) => p(r))
  }
  if (tokens.length === 0) return () => true
  const filter = or()
  if (at !== tokens.length) throw new Error(`filters: unexpected token ${tokens[at]}`)
  return filter
}

/** `facetFilters`: an AND of entries, each `attr:value` or an OR of them. */
function parseFacetFilters(value: unknown, faceted: (attribute: string) => boolean): Filter {
  const one = (entry: string): Filter => {
    const negated = entry.startsWith('-')
    const text = negated ? entry.slice(1) : entry
    const colon = text.indexOf(':')
    if (colon <= 0) throw new Error(`facetFilters: ${entry}`)
    const attribute = text.slice(0, colon)
    const v = text.slice(colon + 1)
    if (!faceted(attribute)) return () => false
    return (r) => facetValues(r, attribute).includes(v) !== negated
  }
  const entries = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  const parts = entries.map((e): Filter => {
    if (typeof e === 'string') return one(e)
    if (Array.isArray(e)) {
      const ors = e.filter((x): x is string => typeof x === 'string').map(one)
      return (r) => ors.some((p) => p(r))
    }
    throw new Error('facetFilters: an entry is neither a string nor an array')
  })
  return (r) => parts.every((p) => p(r))
}

/** A search's parameters: the body's own keys, then `params` (a query string) over them. */
function searchParams(body: unknown, search?: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const take = (params: URLSearchParams) => {
    for (const [key, raw] of params) {
      let value: unknown = raw
      if (/^[[{]/.test(raw)) {
        try {
          value = JSON.parse(raw) as unknown
        } catch {
          value = raw
        }
      } else if (/^-?\d+$/.test(raw) && key !== 'query') value = Number(raw)
      else if (raw === 'true' || raw === 'false') value = raw === 'true'
      out[key] = value
    }
  }
  if (search !== undefined) take(search)
  if (typeof body === 'object' && body !== null) {
    for (const [key, value] of Object.entries(body)) if (key !== 'params') out[key] = value
    const params = (body as { params?: unknown }).params
    if (typeof params === 'string') take(new URLSearchParams(params))
  }
  return out
}

const asList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string' && value !== ''
      ? value.split(',').map((s) => s.trim())
      : []

/** Runs a server that accepts connections and never answers: Algolia hung. */
export async function startSilentServer(): Promise<{ host: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>()
  const server = createServer(() => undefined)
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  return {
    host: `http://127.0.0.1:${port}`,
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export async function startFakeAlgolia(options: FakeAlgoliaOptions = {}): Promise<FakeAlgolia> {
  const live = new Map<string, Index>()
  const tasks = new Map<number, Task>()
  const requests: RecordedRequest[] = []
  let nextTask = 1
  let hook: RequestHook | null = null

  const indexOf = (name: string): Index => {
    let index = live.get(name)
    if (index === undefined) {
      index = { records: new Map(), settings: {} }
      live.set(name, index)
    }
    return index
  }

  function publish(upTo: number): void {
    for (const id of [...tasks.keys()].sort((a, b) => a - b)) {
      if (id > upTo) break
      const task = tasks.get(id)!
      if (task.published) continue
      task.published = true
      clearTimeout(task.timer)
      task.apply()
    }
  }

  function enqueue(apply: () => void): number {
    const id = nextTask++
    const timer = setTimeout(() => publish(id), 1000)
    timer.unref()
    tasks.set(id, { id, polls: 0, published: false, apply, timer })
    return id
  }

  function taskStatus(id: number): Answer {
    const task = tasks.get(id)
    if (task === undefined) return fail(404, 'Task does not exist')
    task.polls += 1
    if (!task.published && task.polls >= 2) publish(id)
    return {
      status: 200,
      body: { status: task.published ? 'published' : 'notPublished', pendingTask: !task.published },
    }
  }

  type Op = { action: string; body?: unknown; indexName?: string }

  function batch(defaultIndex: string | null, ops: unknown): Answer {
    if (!Array.isArray(ops)) return fail(400, 'requests must be an array')
    const planned: Array<{ index: string; action: string; record?: AlgoliaRecord; id?: string }> =
      []
    const objectIDs: string[] = []
    for (const [position, raw] of (ops as Op[]).entries()) {
      const index = defaultIndex ?? raw.indexName
      if (typeof index !== 'string' || index === '') return fail(400, 'indexName is required')
      const action = raw.action
      const body = (typeof raw.body === 'object' && raw.body !== null ? raw.body : {}) as Record<
        string,
        unknown
      >
      if (action === 'clear' || action === 'delete') {
        planned.push({ index, action })
        continue
      }
      if (action === 'deleteObject') {
        if (typeof body['objectID'] !== 'string') return fail(400, 'objectID is required')
        planned.push({ index, action, id: body['objectID'] })
        objectIDs.push(body['objectID'])
        continue
      }
      if (
        action !== 'addObject' &&
        action !== 'updateObject' &&
        action !== 'partialUpdateObject' &&
        action !== 'partialUpdateObjectNoCreate'
      ) {
        return fail(400, `Invalid action: ${String(action)}`)
      }
      if (action !== 'addObject' && typeof body['objectID'] !== 'string') {
        return fail(400, 'objectID is required')
      }
      const record = {
        ...body,
        objectID: typeof body['objectID'] === 'string' ? body['objectID'] : randomUUID(),
      } as AlgoliaRecord
      const size = Buffer.byteLength(JSON.stringify(record), 'utf8')
      if (size > RECORD_LIMIT_BYTES) {
        return fail(
          400,
          `Record at the position ${position} objectID=${record.objectID} is too big size=${size}/${RECORD_LIMIT_BYTES} bytes. Please have a look at https://www.algolia.com/doc/guides/sending-and-managing-data/prepare-your-data/in-depth/index-and-records-size-and-usage-limitations/#record-size-limits`,
        )
      }
      planned.push({ index, action, record, id: record.objectID })
      objectIDs.push(record.objectID)
    }
    const taskID = enqueue(() => {
      for (const op of planned) {
        if (op.action === 'delete') {
          live.delete(op.index)
          continue
        }
        const index = indexOf(op.index)
        if (op.action === 'clear') index.records.clear()
        else if (op.action === 'deleteObject') index.records.delete(op.id!)
        else if (op.action === 'addObject' || op.action === 'updateObject')
          index.records.set(op.id!, clone(op.record!))
        else {
          const before = index.records.get(op.id!)
          if (before === undefined && op.action === 'partialUpdateObjectNoCreate') continue
          index.records.set(op.id!, { ...(before ?? {}), ...clone(op.record!) })
        }
      }
    })
    return { status: 200, body: { taskID, objectIDs } }
  }

  function query(name: string, raw: Record<string, unknown>): Answer {
    const index = live.get(name)
    if (index === undefined) return fail(404, 'Index does not exist')
    const s = { ...DEFAULTS, ...index.settings }
    const q = typeof raw['query'] === 'string' ? raw['query'] : ''
    if (Buffer.byteLength(q, 'utf8') > QUERY_LIMIT_BYTES) {
      return fail(400, `Query is too long: it must be at most ${QUERY_LIMIT_BYTES} bytes`)
    }
    const facetable = asList(s['attributesForFaceting'])
    const faceted = (attribute: string) => facetable.some((a) => bare(a) === attribute)
    const countable = (attribute: string) =>
      facetable.some((a) => bare(a) === attribute && !/^filterOnly\(/.test(a.trim()))

    let filter: Filter = () => true
    try {
      const filters = typeof raw['filters'] === 'string' ? raw['filters'] : ''
      const byFilters = parseFilters(filters, faceted)
      const byFacets =
        raw['facetFilters'] === undefined
          ? () => true
          : parseFacetFilters(raw['facetFilters'], faceted)
      filter = (r) => byFilters(r) && byFacets(r)
    } catch (error) {
      return fail(400, (error as Error).message)
    }

    const exclusions: string[] = []
    let words: string[]
    if (s['advancedSyntax'] === true) {
      const parts = q.split(/\s+/)
      words = parts.filter((p) => !p.startsWith('-')).flatMap(wordsOf)
      exclusions.push(...parts.filter((p) => p.startsWith('-')).flatMap((p) => wordsOf(p)))
    } else {
      words = wordsOf(q)
    }
    const stop = s['removeStopWords']
    if (stop === true || (Array.isArray(stop) && stop.includes('en'))) {
      words = words.filter((w) => !STOP_WORDS.has(w))
    }
    const queryType = s['queryType']
    const prefixAt = (i: number) =>
      queryType === 'prefixAll' || (queryType === 'prefixLast' && i === words.length - 1)
    const typoOn = s['typoTolerance'] !== false && s['typoTolerance'] !== 'false'
    const one = Number(s['minWordSizefor1Typo'])
    const two = Number(s['minWordSizefor2Typos'])
    const plurals = s['ignorePlurals'] === true || Array.isArray(s['ignorePlurals'])

    const searchable = asList(s['searchableAttributes']).map(bare)
    const recordWords = (r: AlgoliaRecord): string[] => {
      const values =
        searchable.length > 0
          ? searchable.flatMap((a) => textsOf(valueAt(r, a)))
          : Object.entries(r)
              .filter(([k]) => k !== 'objectID')
              .flatMap(([, v]) => textsOf(v))
      return values.flatMap(wordsOf)
    }
    const wordMatches = (qw: string, rw: string, prefix: boolean): boolean => {
      if (prefix ? rw.startsWith(qw) : rw === qw) return true
      if (plurals && singular(rw) === singular(qw)) return true
      if (!typoOn || qw.length < one) return false
      const allowed = qw.length >= two ? 2 : 1
      return prefix ? typos(qw, rw.slice(0, qw.length)) <= allowed : typos(qw, rw) <= allowed
    }

    const hits = [...index.records.values()].filter((r) => {
      if (!filter(r)) return false
      const own = recordWords(r)
      if (exclusions.some((x) => own.includes(x))) return false
      return words.every((qw, i) => own.some((rw) => wordMatches(qw, rw, prefixAt(i))))
    })

    const limitedTo = Number(s['paginationLimitedTo'])
    const reachable = hits.slice(0, limitedTo)
    const hitsPerPage = Number(raw['hitsPerPage'] ?? s['hitsPerPage'])
    const length = raw['length'] === undefined ? undefined : Number(raw['length'])
    if (hitsPerPage > 1000 || (length !== undefined && length > 1000)) {
      return fail(400, 'hitsPerPage and length must be at most 1000')
    }
    let page: AlgoliaRecord[]
    const meta: Record<string, unknown> = {}
    if (raw['offset'] !== undefined) {
      const offset = Number(raw['offset'])
      const size = length ?? hitsPerPage
      page = reachable.slice(offset, offset + size)
      meta['offset'] = offset
      meta['length'] = size
    } else {
      const p = Number(raw['page'] ?? 0)
      page = reachable.slice(p * hitsPerPage, (p + 1) * hitsPerPage)
    }
    const retrieve = asList(raw['attributesToRetrieve'])
    const shown = page.map((r) => {
      if (retrieve.length === 0 || retrieve.includes('*')) return clone(r)
      const out: Record<string, unknown> = { objectID: r.objectID }
      for (const a of retrieve) if (a in r) out[a] = clone(r[a])
      return out
    })

    const body: Record<string, unknown> = {
      hits: shown,
      nbHits: hits.length,
      page: Number(raw['page'] ?? 0),
      nbPages: Math.ceil(reachable.length / Math.max(1, hitsPerPage)),
      hitsPerPage,
      exhaustiveNbHits: true,
      exhaustiveFacetsCount: true,
      query: q,
      params: '',
      processingTimeMS: 1,
      ...meta,
    }
    const requested = asList(raw['facets'])
    if (requested.length > 0) {
      const names = requested.includes('*')
        ? facetable.filter((a) => countable(bare(a))).map(bare)
        : requested.filter(countable)
      const maxValues = Number(raw['maxValuesPerFacet'] ?? s['maxValuesPerFacet'])
      const facets: Record<string, Record<string, number>> = {}
      for (const name of names) {
        const counts = new Map<string, number>()
        for (const r of hits)
          for (const v of facetValues(r, name)) counts.set(v, (counts.get(v) ?? 0) + 1)
        facets[name] = Object.fromEntries(
          [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).slice(0, maxValues),
        )
      }
      body['facets'] = facets
    }
    return { status: 200, body }
  }

  function operation(source: string, raw: unknown): Answer {
    const body = (raw ?? {}) as { operation?: unknown; destination?: unknown; scope?: unknown }
    if (body.operation !== 'copy' && body.operation !== 'move') {
      return fail(400, 'operation must be copy or move')
    }
    if (typeof body.destination !== 'string' || body.destination === '') {
      return fail(400, 'destination is required')
    }
    const destination = body.destination
    const scope = asList(body.scope)
    const op = body.operation
    const taskID = enqueue(() => {
      const from = live.get(source) ?? { records: new Map(), settings: {} }
      if (op === 'move') {
        live.set(destination, { records: new Map(from.records), settings: clone(from.settings) })
        live.delete(source)
        return
      }
      if (scope.length === 0) {
        live.set(destination, {
          records: new Map([...from.records].map(([k, v]) => [k, clone(v)])),
          settings: clone(from.settings),
        })
        return
      }
      const to = indexOf(destination)
      if (scope.includes('settings')) to.settings = clone(from.settings)
    })
    return { status: 200, body: { taskID, updatedAt: new Date().toISOString() } }
  }

  async function route(
    method: string,
    path: string,
    search: URLSearchParams,
    body: unknown,
  ): Promise<Answer> {
    let m: RegExpExecArray | null
    if (method === 'GET' && path === '/1/indexes') {
      return {
        status: 200,
        body: {
          items: [...live].map(([name, i]) => ({ name, entries: i.records.size })),
          nbPages: 1,
        },
      }
    }
    if (method === 'POST' && path === '/1/indexes/*/batch') {
      return batch(null, (body as { requests?: unknown } | null)?.requests)
    }
    if (method === 'POST' && path === '/1/indexes/*/queries') {
      const list = (body as { requests?: unknown } | null)?.requests
      if (!Array.isArray(list)) return fail(400, 'requests must be an array')
      const results: unknown[] = []
      for (const r of list as Array<Record<string, unknown>>) {
        const answer = query(String(r['indexName']), searchParams(r))
        if (answer.status !== 200) return answer
        results.push({ ...(answer.body as object), index: r['indexName'] })
      }
      return { status: 200, body: { results } }
    }
    if (method === 'GET' && (m = /^\/1\/task\/(\d+)$/.exec(path)) !== null) {
      return taskStatus(Number(m[1]))
    }
    if ((m = /^\/1\/indexes\/([^/]+)(?:\/(.+))?$/.exec(path)) === null) {
      return fail(404, 'Not Found')
    }
    const name = decodeURIComponent(m[1]!)
    const rest = m[2]
    if (rest === undefined) {
      if (method === 'GET') return query(name, searchParams(undefined, search))
      if (method === 'POST') {
        const answer = batch(name, [{ action: 'addObject', body }])
        const b = answer.body as { taskID?: number; objectIDs?: string[] }
        return answer.status !== 200
          ? answer
          : { status: 201, body: { taskID: b.taskID, objectID: b.objectIDs?.[0] } }
      }
      if (method === 'DELETE') {
        const taskID = enqueue(() => live.delete(name))
        return { status: 200, body: { taskID, deletedAt: new Date().toISOString() } }
      }
      return fail(405, `${method} is not allowed`)
    }
    if (rest === 'batch' && method === 'POST') {
      return batch(name, (body as { requests?: unknown } | null)?.requests)
    }
    if (rest === 'query' && method === 'POST') return query(name, searchParams(body))
    if (rest === 'settings' && method === 'GET') {
      const index = live.get(name)
      return index === undefined
        ? fail(404, 'Index does not exist')
        : { status: 200, body: { ...DEFAULTS, ...clone(index.settings) } }
    }
    if (rest === 'settings' && method === 'PUT') {
      if (typeof body !== 'object' || body === null) return fail(400, 'settings must be an object')
      const given = clone(body as Record<string, unknown>)
      const taskID = enqueue(() => {
        const index = indexOf(name)
        index.settings = { ...index.settings, ...given }
      })
      return { status: 200, body: { taskID, updatedAt: new Date().toISOString() } }
    }
    if (rest === 'operation' && method === 'POST') return operation(name, body)
    if (rest === 'clear' && method === 'POST') return batch(name, [{ action: 'clear' }])
    if ((m = /^task\/(\d+)$/.exec(rest)) !== null && method === 'GET') {
      return taskStatus(Number(m[1]))
    }
    const objectID = decodeURIComponent(rest)
    if (method === 'PUT') {
      const answer = batch(name, [
        { action: 'updateObject', body: { ...(body as object), objectID } },
      ])
      const b = answer.body as { taskID?: number }
      return answer.status !== 200
        ? answer
        : { status: 200, body: { taskID: b.taskID, objectID, updatedAt: new Date().toISOString() } }
    }
    if (method === 'DELETE') {
      const answer = batch(name, [{ action: 'deleteObject', body: { objectID } }])
      const b = answer.body as { taskID?: number }
      return answer.status !== 200
        ? answer
        : { status: 200, body: { taskID: b.taskID, deletedAt: new Date().toISOString() } }
    }
    if (method === 'GET') {
      const record = live.get(name)?.records.get(objectID)
      return record === undefined
        ? fail(404, 'ObjectID does not exist')
        : { status: 200, body: clone(record) }
    }
    return fail(405, `${method} is not allowed`)
  }

  function authorised(req: IncomingMessage, search: URLSearchParams): boolean {
    const header = (name: string) => {
      const value = req.headers[name]
      return typeof value === 'string' ? value : (search.get(name) ?? undefined)
    }
    const appId = header('x-algolia-application-id')
    const apiKey = header('x-algolia-api-key')
    if (appId === undefined || appId === '' || apiKey === undefined || apiKey === '') return false
    if (options.appId !== undefined && appId !== options.appId) return false
    if (options.apiKey !== undefined && apiKey !== options.apiKey) return false
    return true
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const url = new URL(req.url ?? '/', 'http://fake.algolia')
    const path = url.pathname
    const raw = await readBody(req)
    const named = /^\/1\/indexes\/([^/]+)/.exec(path)?.[1]
    const index = named === undefined || named === '*' ? null : decodeURIComponent(named)
    let body: unknown = null
    let answer: Answer
    try {
      body = raw === '' ? null : (JSON.parse(raw) as unknown)
      if (method === 'GET' && path === '/1/isalive') {
        answer = { status: 200, body: { message: 'server is alive' } }
      } else if (!authorised(req, url.searchParams)) {
        answer = fail(403, 'Invalid Application-ID or API key')
      } else {
        if (hook !== null) await hook({ method, path, index, body })
        answer = await route(method, path, url.searchParams, body)
      }
    } catch (error) {
      answer = error instanceof SyntaxError ? fail(400, 'Invalid JSON') : fail(500, String(error))
    }
    requests.push({ method, path, index, body, status: answer.status })
    res.writeHead(answer.status, { 'content-type': 'application/json; charset=UTF-8' })
    res.end(JSON.stringify(answer.body))
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: String(error), status: 500 }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo

  return {
    host: `http://127.0.0.1:${port}`,
    requests,
    records: (name) => [...(live.get(name)?.records.values() ?? [])].map(clone),
    settings: (name) => {
      const index = live.get(name)
      return index === undefined ? undefined : clone(index.settings)
    },
    indexes: () => [...live.keys()],
    load(name, records) {
      const index = indexOf(name)
      for (const r of records) index.records.set(r.objectID, clone(r))
    },
    intercept(next) {
      hook = next
    },
    async close() {
      for (const task of tasks.values()) clearTimeout(task.timer)
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
