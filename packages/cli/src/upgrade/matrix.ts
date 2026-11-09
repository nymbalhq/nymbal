import semver from 'semver'

export const MATRIX_URL = 'https://nymbalhq.github.io/nymbal/matrix.json'

const DEFAULT_TIMEOUT_MS = 10_000

export type AdapterStatus = 'passing' | 'failing' | 'suspended' | 'no-suite' | 'first-party'
export interface MatrixAdapter {
  version: string | null
  status: AdapterStatus
  line?: string
}
export interface MatrixRow {
  packages: Record<string, string>
  adapters: Record<string, MatrixAdapter>
}
export interface Matrix {
  schema: 1
  generatedAt: string
  stacks: Record<string, MatrixRow>
}

export class MatrixError extends Error {}

const STATUSES: readonly unknown[] = ['passing', 'failing', 'suspended', 'no-suite', 'first-party']

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Canonical semver only: these values are written into a store's package.json and handed to its package manager. */
const isVersion = (v: unknown): v is string => typeof v === 'string' && semver.valid(v) === v

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new MatrixError(`${field}: not an object`)
  return value
}

function checkAdapter(value: unknown, field: string): void {
  const adapter = record(value, field)
  const { version, status, line } = adapter
  if (!STATUSES.includes(status)) {
    throw new MatrixError(`${field}.status: ${JSON.stringify(status)} is not a status`)
  }
  if (version === null) {
    if (status !== 'failing' && status !== 'suspended') {
      throw new MatrixError(`${field}.version: null is only for failing or suspended`)
    }
  } else if (!isVersion(version)) {
    throw new MatrixError(`${field}.version: ${JSON.stringify(version)} is not a version`)
  }
  if (line !== undefined && typeof line !== 'string') {
    throw new MatrixError(`${field}.line: not a string`)
  }
}

/** The matrix `value` holds, or a MatrixError naming the first field that is wrong. */
export function parseMatrix(value: unknown): Matrix {
  const doc = record(value, 'matrix')
  if (doc['schema'] !== 1) {
    throw new MatrixError(`schema: expected 1, found ${JSON.stringify(doc['schema'])}`)
  }
  if (typeof doc['generatedAt'] !== 'string') throw new MatrixError('generatedAt: not a string')
  for (const [stack, rowValue] of Object.entries(record(doc['stacks'], 'stacks'))) {
    if (!isVersion(stack))
      throw new MatrixError(`stacks: ${JSON.stringify(stack)} is not a version`)
    const field = `stacks.${stack}`
    const row = record(rowValue, field)
    for (const [name, version] of Object.entries(record(row['packages'], `${field}.packages`))) {
      if (!isVersion(version)) {
        throw new MatrixError(
          `${field}.packages.${name}: ${JSON.stringify(version)} is not a version`,
        )
      }
    }
    for (const [name, adapter] of Object.entries(record(row['adapters'], `${field}.adapters`))) {
      checkAdapter(adapter, `${field}.adapters.${name}`)
    }
  }
  return value as Matrix
}

/** The matrix at `url`; a connection, status, timeout, JSON or shape failure is a MatrixError. */
export async function fetchMatrix(
  url: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<Matrix> {
  const get = opts.fetch ?? fetch
  try {
    const res = await get(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    if (!res.ok) throw new MatrixError(`the server answered ${res.status}`)
    return parseMatrix(JSON.parse(await res.text()))
  } catch (err) {
    if (err instanceof MatrixError) throw err
    throw new MatrixError(err instanceof Error ? err.message : String(err))
  }
}
