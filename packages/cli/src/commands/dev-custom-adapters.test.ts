import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { matchesQuery, type ContractProduct } from '../../../contract-tests/src/index.js'
import { FIXTURE_SEARCH_CAPABILITIES } from '../../../../tests/e2e/fixtures/custom-providers/adapters.js'

// P2-05 AC-5 (integration) and decision 8: `nymbal dev --api-only`, run from the swap fixture's directory
// (tests/e2e/fixtures/custom-providers), starts with both `custom` slots filled from the config's `adapters` export,
// and the API it serves answers through them: the capabilities report is the fixture's (search without `facet`,
// payments with no client), the listing has no facets, and search matches by P2-07 decision 3 (name, SKU, variant name
// or description; decision 9 moved the fixture there). Kills: a CLI that cannot run a `custom` slot
// (`adapter.custom_mismatch` at start), and one that starts on the native adapters anyway.
// Spawns the built CLI (`pnpm build` first), on a free port and a fresh SQLite file of its own.

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_BIN = resolve(HERE, '..', '..', 'bin', 'nymbal.mjs')
const FIXTURE_DIR = resolve(
  HERE,
  '..',
  '..',
  '..',
  '..',
  'tests',
  'e2e',
  'fixtures',
  'custom-providers',
)
/** Migrate, seed and listen take about 3 s warm; past this the API is not coming up. */
const READY_WITHIN_MS = 45_000

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolvePort(port))
    })
  })
}

interface Report {
  payments: { capabilities: string[]; client: unknown }
  search: { capabilities: string[] }
}

let base = ''
let stop: () => Promise<void> = async () => undefined
let startError: Error | null = null

beforeAll(async () => {
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'nymbal-p2-05-'))
  const child = spawn(process.execPath, [CLI_BIN, 'dev', '--api-only', '--port', String(port)], {
    cwd: FIXTURE_DIR,
    env: { ...process.env, NYMBAL_SQLITE_PATH: join(dir, 'nymbal.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout?.on('data', (b: Buffer) => (out += b.toString()))
  child.stderr?.on('data', (b: Buffer) => (out += b.toString()))
  let gone = false
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  void exited.then(() => (gone = true))
  stop = async () => {
    if (!gone) {
      child.kill('SIGKILL')
      await exited
    }
    rmSync(dir, { recursive: true, force: true })
  }

  base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + READY_WITHIN_MS
  while (Date.now() < deadline && !gone) {
    const up = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
      .then((r) => r.ok)
      .catch(() => false)
    if (up) return
    await new Promise((r) => setTimeout(r, 200))
  }
  startError = new Error(
    `nymbal dev --api-only from ${FIXTURE_DIR} did not answer GET /health within ${READY_WITHIN_MS} ms` +
      ` (${gone ? 'it exited' : 'still running'}). Output:\n${out.slice(-2000)}`,
  )
}, READY_WITHIN_MS + 15_000)

afterAll(async () => {
  await stop()
})

async function get<T>(path: string): Promise<{ status: number; data: T }> {
  if (startError !== null) throw startError
  const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) })
  const body = (await res.json()) as { data: T }
  return { status: res.status, data: body.data }
}

describe('nymbal dev --api-only from the custom-providers fixture', () => {
  it('AC-5: starts with both custom slots: GET /api/capabilities reports the fixture search (no facet) and payments with no client', async () => {
    const res = await get<Report>('/api/capabilities')

    expect(res.status).toBe(200)
    expect(res.data.search.capabilities).toEqual([...FIXTURE_SEARCH_CAPABILITIES])
    expect(res.data.payments.client).toBeNull()
  })

  it('AC-5: the listing it serves has no facets, and search answers by decision 3: exactly the listed products whose name, SKU, variant name or description matches the term', async () => {
    const listing = await get<{
      items: Array<ContractProduct & { slug: string }>
      facets?: unknown
    }>('/api/products?limit=100')
    const found = await get<{ items: Array<{ slug: string }> }>(
      '/api/products/search?q=wool&limit=100',
    )

    expect(listing.status).toBe(200)
    expect(Object.hasOwn(listing.data, 'facets')).toBe(false)
    const matching = listing.data.items.filter((p) => matchesQuery(p, 'wool'))
    expect(matching.length).toBeGreaterThan(0)
    expect(found.data.items.map((p) => p.slug).sort()).toEqual(matching.map((p) => p.slug).sort())
  })
})
