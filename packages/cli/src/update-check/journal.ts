import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'
const DEFAULT_TIMEOUT_MS = 10_000
const DIALECTS = ['sqlite', 'postgres'] as const
type Dialect = (typeof DIALECTS)[number]

/** Migration tags in journal order, per dialect. */
export interface Journals {
  sqlite: string[]
  postgres: string[]
}

/** The head's tags its base does not hold, compared per dialect, each once, sqlite's first. */
export function addedMigrations(base: Journals, head: Journals): string[] {
  const added = new Set<string>()
  for (const dialect of DIALECTS) {
    const known = new Set(base[dialect])
    for (const tag of head[dialect]) if (!known.has(tag)) added.add(tag)
  }
  return [...added]
}

const journalPath = (dialect: Dialect): string => `migrations/${dialect}/meta/_journal.json`

function tagsOf(text: string, where: string): string[] {
  let entries: unknown
  try {
    entries = (JSON.parse(text) as { entries?: unknown }).entries
  } catch (err) {
    throw new Error(`${where} is not JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!Array.isArray(entries)) throw new Error(`${where} has no entries`)
  return entries.map((entry, i) => {
    const tag = (entry as { tag?: unknown } | null)?.tag
    if (typeof tag !== 'string') throw new Error(`${where}: entry ${i} has no tag`)
    return tag
  })
}

/** The journals of the @nymbalhq/platform installed at `platformDir`. */
export function installedJournals(platformDir: string): Journals {
  const read = (dialect: Dialect): string[] => {
    const file = join(platformDir, journalPath(dialect))
    return tagsOf(readFileSync(file, 'utf8'), file)
  }
  return { sqlite: read('sqlite'), postgres: read('postgres') }
}

const cString = (block: Buffer, start: number, length: number): string => {
  const field = block.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? length : end).toString('utf8')
}

/** Each regular file of a ustar archive, its path without the archive's top directory (npm's `package/`). */
function untar(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  let offset = 0
  while (offset + 512 <= archive.length) {
    const block = archive.subarray(offset, offset + 512)
    if (block.every((byte) => byte === 0)) break
    const sizeField = cString(block, 124, 12).trim()
    const size = Number.parseInt(sizeField, 8)
    if (!/^[0-7]+$/.test(sizeField) || !Number.isSafeInteger(size)) {
      throw new Error(`not a tar archive: an entry size of ${JSON.stringify(sizeField)}`)
    }
    const name = cString(block, 0, 100)
    const prefix = cString(block, 257, 6).startsWith('ustar') ? cString(block, 345, 155) : ''
    const type = cString(block, 156, 1)
    if (type === '' || type === '0') {
      const path = (prefix === '' ? name : `${prefix}/${name}`).split('/').slice(1).join('/')
      files.set(path, archive.subarray(offset + 512, offset + 512 + size))
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

async function get(url: string, timeoutMs: number, fetcher: typeof fetch, what: string) {
  let res: Response
  let body: Buffer
  try {
    res = await fetcher(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    })
    body = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    throw new Error(
      `cannot fetch ${what} from ${url}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!res.ok) throw new Error(`the registry answered ${res.status} for ${what} at ${url}`)
  return body
}

/**
 * The published package's journals: packument from `registry` (default `npm_config_registry`, else
 * https://registry.npmjs.org/), its `dist.tarball`, gunzipped, `package/migrations/<dialect>/meta/_journal.json`.
 * Rejects with an Error naming what failed; every request bounded by `timeoutMs` (default 10 000).
 */
export async function publishedJournals(
  name: string,
  version: string,
  opts: { registry?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<Journals> {
  const fetcher = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const registry = opts.registry ?? process.env['npm_config_registry'] ?? DEFAULT_REGISTRY
  const packumentUrl = `${registry.endsWith('/') ? registry : `${registry}/`}${name.replace('/', '%2f')}`

  const packumentBody = await get(packumentUrl, timeoutMs, fetcher, `the packument of ${name}`)
  let tarballUrl: unknown
  try {
    const packument = JSON.parse(packumentBody.toString('utf8')) as {
      versions?: Record<string, { dist?: { tarball?: unknown } }>
    }
    tarballUrl = packument.versions?.[version]?.dist?.tarball
  } catch {
    throw new Error(`the packument of ${name} at ${packumentUrl} is not JSON`)
  }
  if (typeof tarballUrl !== 'string') {
    throw new Error(`${name}@${version} is not in the registry at ${packumentUrl}`)
  }

  const what = `the tarball of ${name}@${version}`
  const gzipped = await get(tarballUrl, timeoutMs, fetcher, what)
  let files: Map<string, Buffer>
  try {
    files = untar(gunzipSync(gzipped))
  } catch (err) {
    throw new Error(
      `${what} cannot be gunzipped and read: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const read = (dialect: Dialect): string[] => {
    const file = files.get(journalPath(dialect))
    if (file === undefined) throw new Error(`${what} holds no ${journalPath(dialect)} journal`)
    return tagsOf(file.toString('utf8'), `${what}: ${journalPath(dialect)}`)
  }
  return { sqlite: read('sqlite'), postgres: read('postgres') }
}
