import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatReport, runWooCommerceImport, type ImportReport } from '@nymbalhq/importers'
import type { ServiceRegistry } from '@nymbalhq/platform'
import { buildImportEnv } from './support/import-env.js'
import {
  json,
  loadRecordedStore,
  localMedia,
  recordedFetch,
  recordedImportOptions,
} from './support/recorded-store.js'

// What the import could not carry over exactly is reported once: in the report, in the state file and under "Review
// before launch". Store A (recorded) has a lossy mapping of every kind; its settings answer 401 here, so the run also
// warns that it assumed the store's units. A run stopped before any create and resumed must report what a run never
// stopped reports. Needs `pnpm build`.

type Warning = { phase: string; id?: string; message: string }

const store = loadRecordedStore('store-a-gbp')
const settingsRefused = {
  override: (path: string) =>
    path.startsWith('/settings') ? json({ code: 'woocommerce_rest_cannot_view' }, 401) : undefined,
}

/** Store A's products whose import is lossy (AC-2, AC-3, AC-7), by SKU, and why. */
const LOSSY: Record<string, string> = {
  'MUG-01': 'a sale with an end date',
  'BLANKET-01': 'a sale scheduled to start later',
  'WRAP-01': 'untracked, in stock',
  'CANDLE-01': 'untracked, on backorder',
  'PATTERN-01': 'untracked, in stock',
  'PAN-01': 'negative stock',
  'BUNDLE-01': 'no price',
  'SET-01': 'grouped',
  'LAMP-EXT': 'external',
  TSHIRT: 'an untracked variation',
  SOCKS: 'a shared parent stock pool',
  JACKET: 'a variation with no price, and one with negative stock',
  WREATH: 'no variation has a price',
}

const key = (w: Warning) => JSON.stringify([w.phase, w.id ?? null, w.message])
const keys = (ws: Warning[]) => ws.map(key).sort()

const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

/** A call wrapper that lets `limit` calls through and holds every later one forever, as a process stopped there. */
function stopAfter(limit: number) {
  let started = 0
  let reached!: () => void
  const stopped = new Promise<void>((resolve) => {
    reached = resolve
  })
  function gate<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
    return (...args: A): Promise<R> => {
      started += 1
      if (started > limit) {
        reached()
        return new Promise<R>(() => undefined)
      }
      return fn(...args)
    }
  }
  return { gate, stopped }
}

/** The services with the product creates held after `limit`. */
function createsStoppedAfter(services: ServiceRegistry, limit: number) {
  const { gate, stopped } = stopAfter(limit)
  const product = new Proxy(services.product, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown
      if (typeof value !== 'function') return value
      const bound = (value as (...a: unknown[]) => Promise<unknown>).bind(target)
      return prop === 'create' ? gate(bound) : bound
    },
  })
  return { services: { ...services, product } as ServiceRegistry, stopped }
}

async function oneShot(): Promise<ImportReport> {
  const dir = await mkdtemp(join(tmpdir(), 'nymbal-warnings-once-'))
  dirs.push(dir)
  const env = await buildImportEnv()
  try {
    vi.stubGlobal('fetch', recordedFetch(store, settingsRefused).fetch)
    return await runWooCommerceImport(recordedImportOptions(store, dir), {
      services: env.services,
      repos: env.repos,
      adapters: env.adapters,
      media: localMedia(dir),
    })
  } finally {
    await env.close()
  }
}

/** The item lines under "## Review before launch", up to the next heading of its level. */
function reviewLines(markdown: string): string[] {
  const lines = markdown.split('\n')
  const start = lines.indexOf('## Review before launch')
  if (start < 0) return []
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? lines.length : end).filter((l) => l.startsWith('- '))
}

describe('warnings in the report, the state file and the migration report', () => {
  it('AC-9: every lossy product of the recorded store and no other is warned about, the unread settings once, and each warning appears once in the report, the state file and under "Review before launch"', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nymbal-warnings-'))
    dirs.push(dir)
    const env = await buildImportEnv()
    try {
      vi.stubGlobal('fetch', recordedFetch(store, settingsRefused).fetch)
      const opts = recordedImportOptions(store, dir)
      const report = await runWooCommerceImport(opts, {
        services: env.services,
        repos: env.repos,
        adapters: env.adapters,
        media: localMedia(dir),
      })
      const warnings: Warning[] = report.warnings

      const warnedIds = new Set(warnings.map((w) => w.id))
      const silent = Object.entries(LOSSY)
        .map(([sku, why]) => {
          const id = store.products.find((p) => p['sku'] === sku)!['id'] as number
          // A warning about one of its variations may carry the variation's id.
          const ids = [id, ...(store.variations[id] ?? []).map((v) => v['id'] as number)]
          return ids.some((i) => warnedIds.has(String(i))) ? null : `${sku} (${id}): ${why}`
        })
        .filter((s) => s !== null)
      expect(silent).toEqual([])
      // And only those: a product carried over exactly (a count of 0, untracked and out of stock) is not warned about.
      const parentOf = new Map<number, number>()
      for (const [parent, vs] of Object.entries(store.variations)) {
        for (const v of vs) parentOf.set(v['id'] as number, Number(parent))
      }
      const warnedProducts = new Set(
        warnings
          .filter((w) => w.phase === 'products')
          .map((w) => parentOf.get(Number(w.id)) ?? Number(w.id)),
      )
      const lossyIds = Object.keys(LOSSY).map(
        (sku) => store.products.find((p) => p['sku'] === sku)!['id'] as number,
      )
      expect([...warnedProducts].sort((a, b) => a - b)).toEqual(lossyIds.sort((a, b) => a - b))
      expect(warnings.filter((w) => w.phase === 'settings')).toHaveLength(1)

      expect(new Set(keys(warnings)).size).toBe(warnings.length)
      const state = JSON.parse(await readFile(opts.statePath, 'utf8')) as { warnings: Warning[] }
      expect(keys(state.warnings)).toEqual(keys(warnings))

      const lines = reviewLines(formatReport(report, 'Store A'))
      expect(lines.length).toBe(warnings.length)
      for (const w of warnings) {
        expect(
          lines.some((l) => l.includes(w.message)),
          w.message,
        ).toBe(true)
      }
    } finally {
      await env.close()
    }
  })

  it('AC-9: property: an import stopped before its (k+1)-th product create and resumed reports the warnings of an import never stopped, each once, in its report and its state file', async () => {
    const whole = keys((await oneShot()).warnings)
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: store.products.length - 1 }), async (k) => {
        const dir = await mkdtemp(join(tmpdir(), 'nymbal-warnings-resumed-'))
        dirs.push(dir)
        const env = await buildImportEnv()
        try {
          vi.stubGlobal('fetch', recordedFetch(store, settingsRefused).fetch)
          const opts = recordedImportOptions(store, dir)
          const deps = {
            services: env.services,
            repos: env.repos,
            adapters: env.adapters,
            media: localMedia(dir),
          }
          const { services, stopped } = createsStoppedAfter(env.services, k)
          const first = runWooCommerceImport(opts, { ...deps, services })
          first.catch(() => undefined)
          await Promise.race([stopped, first])

          const resumed = await runWooCommerceImport({ ...opts, fresh: false }, deps)
          expect(keys(resumed.warnings), `stopped after ${k} creates`).toEqual(whole)
          const state = JSON.parse(await readFile(opts.statePath, 'utf8')) as {
            warnings: Warning[]
          }
          expect(keys(state.warnings), `stopped after ${k} creates`).toEqual(whole)
        } finally {
          await env.close()
        }
      }),
      { numRuns: 5, examples: [[1], [store.products.length - 1]] },
    )
  }, 120_000)
})
