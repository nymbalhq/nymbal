import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatReport, runWooCommerceImport, type ImportReport } from '@nymbalhq/importers'
import type { ServiceRegistry } from '@nymbalhq/platform'
import type { MediaStorage } from '@nymbalhq/types'
import {
  buildImportEnv,
  importedMedia,
  importOptions,
  offlineLookup,
  sourceCatalogue,
  wooFetch,
} from './support/import-env.js'

// An image the import could not bring over is named in the report with why, under `media`, and its product is still
// created with every other image, in order. Each source image here either serves or fails one way: a 404, a 503, an
// HTML page, a host that is not public (an address literal, never requested), a refused connection, a URL with a
// user name and password (which fetch refuses) or an expired signed URL. Runs against the built dist (`pnpm build`).

type Warning = { phase: string; id?: string; message: string }
type Outcome =
  | 'stored'
  | 'http404'
  | 'http503'
  | 'html'
  | 'internal'
  | 'unreachable'
  | 'credentialed'
  | 'expired'

/** What the warning for an image that failed this way must say, beside its src. */
const REASON: Record<Exclude<Outcome, 'stored'>, string> = {
  http404: 'HTTP 404',
  http503: 'HTTP 503',
  html: 'unsupported type text/html',
  internal: 'is not a public address',
  unreachable: 'ECONNREFUSED',
  credentialed: 'TypeError',
  expired: 'HTTP 403',
}

/** The secrets a credentialed or signed src carries, which no warning, report, state or journal line may repeat. */
const SECRETS = ['hunter2', 'X-Amz-Signature', 'X-Amz-Credential']

/** An image URL as a warning names it: its scheme, host and path. */
const shown = (src: string): string => {
  const url = new URL(src)
  return `${url.protocol}//${url.host}${url.pathname}`
}

const catalogue = sourceCatalogue(3)
const sources = catalogue.products.flatMap((p) =>
  p.images.map((image) => ({ product: p.id, image })),
)
const realFetch = globalThis.fetch
const dirs: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/** A media storage whose URLs carry a put counter, and which records the bytes each URL was put with. */
function recordingMedia() {
  const urlOfBytes = new Map<string, string>()
  let n = 0
  const media: MediaStorage = {
    capabilities: () => ['put'],
    async put(key, body) {
      const url = `https://media.test/${++n}/${key}`
      urlOfBytes.set(hex(body), url)
      return { url }
    },
  }
  return { media, urlOfBytes }
}

/**
 * The catalogue with each image failing as `outcomes` says, in source order: the src the product lists and what
 * fetch answers for it. An internal image is listed at an address literal, so the policy refuses it unrequested.
 */
function failingSource(outcomes: Outcome[]) {
  const answers = new Map<string, () => Response>()
  const listed = new Map<string, string>()
  sources.forEach(({ image }, i) => {
    const outcome = outcomes[i]!
    let src = image.src
    if (outcome === 'internal') src = `http://10.0.0.${i + 1}/img-${i}.jpg`
    if (outcome === 'unreachable') src = `https://down-${i}.cdn.test/img-${i}.jpg`
    if (outcome === 'credentialed') src = `https://shopuser:hunter2@cdn.test/img-${i}.jpg`
    if (outcome === 'expired') {
      src = `https://bucket.s3.test/img-${i}.jpg?X-Amz-Credential=AKIA%2F${i}&X-Amz-Signature=5ec2e7${i}#top`
    }
    if (outcome === 'http404') answers.set(src, () => new Response('not found', { status: 404 }))
    if (outcome === 'http503') answers.set(src, () => new Response('busy', { status: 503 }))
    if (outcome === 'expired') answers.set(src, () => new Response('expired', { status: 403 }))
    if (outcome === 'html') {
      answers.set(
        src,
        () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      )
    }
    if (outcome === 'unreachable') {
      answers.set(src, () => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        })
      })
    }
    if (outcome === 'credentialed') {
      // As undici's Request constructor refuses it, the URL quoted in the message.
      answers.set(src, () => {
        throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${src}`)
      })
    }
    listed.set(image.src, src)
  })
  const wcProducts = catalogue.wcProducts.map((wc) => ({
    ...wc,
    images: (wc['images'] as Array<{ src: string }>).map((img) => ({
      ...img,
      src: listed.get(img.src)!,
    })),
  }))
  const base = wooFetch({ ...catalogue, wcProducts }, realFetch)
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const answer = answers.get(href)
    return answer === undefined ? base(input, init) : answer()
  }) as typeof fetch
  return { fetch: fetchImpl, srcOf: (i: number) => listed.get(sources[i]!.image.src)! }
}

async function runImport(outcomes: Outcome[], services?: (s: ServiceRegistry) => ServiceRegistry) {
  const dir = await mkdtemp(join(tmpdir(), 'nymbal-media-failures-'))
  dirs.push(dir)
  const env = await buildImportEnv()
  const source = failingSource(outcomes)
  vi.stubGlobal('fetch', source.fetch)
  const { media, urlOfBytes } = recordingMedia()
  const opts = importOptions(dir)
  const deps = {
    services: env.services,
    repos: env.repos,
    adapters: env.adapters,
    media,
    lookup: offlineLookup,
  }
  return { env, opts, deps, source, urlOfBytes, stopping: services?.(env.services) }
}

const mediaWarnings = (warnings: Warning[]) => warnings.filter((w) => w.phase === 'media')
const key = (w: Warning) => JSON.stringify([w.phase, w.id ?? null, w.message])

describe('AC-1: images that are not stored are reported and the product still imports', () => {
  it('AC-1: property: whichever images fail and however, every product is created with exactly its other images in order, and each failed image is one media warning on its product naming its host, path and the reason; nothing else is a media warning or an error, and no user name, password or signed query reaches the report, state file or journal', async () => {
    const outcome = fc.constantFrom<Outcome>(
      'stored',
      'http404',
      'http503',
      'html',
      'internal',
      'unreachable',
      'credentialed',
      'expired',
    )
    await fc.assert(
      fc.asyncProperty(
        fc.array(outcome, { minLength: sources.length, maxLength: sources.length }),
        async (outcomes) => {
          const run = await runImport(outcomes)
          try {
            const report: ImportReport = await runWooCommerceImport(run.opts, run.deps)

            expect(report.errors).toEqual([])
            expect(report.imported.products).toBe(catalogue.products.length)
            const imported = await importedMedia(run.env, run.opts.statePath)
            for (const product of catalogue.products) {
              const kept = sources
                .map((s, i) => ({ ...s, outcome: outcomes[i]! }))
                .filter((s) => s.product === product.id && s.outcome === 'stored')
              expect(imported.get(product.id), `product ${product.id}`).toEqual(
                kept.map((s) => run.urlOfBytes.get(hex(s.image.bytes))),
              )
            }

            const failed = sources
              .map((s, i) => ({
                product: s.product,
                src: run.source.srcOf(i),
                outcome: outcomes[i]!,
              }))
              .filter((f) => f.outcome !== 'stored')
            const warned = mediaWarnings(report.warnings)
            expect(warned.length).toBe(failed.length)
            for (const f of failed) {
              const own = warned.filter(
                (w) => w.id === String(f.product) && w.message.includes(shown(f.src)),
              )
              expect(own.length, f.src).toBe(1)
              expect(own[0]!.message, f.src).toContain(REASON[f.outcome as keyof typeof REASON])
            }
            const state = JSON.parse(await readFile(run.opts.statePath, 'utf8')) as {
              warnings: Warning[]
            }
            expect(mediaWarnings(state.warnings).map(key).sort()).toEqual(warned.map(key).sort())

            const written = {
              report: formatReport(report, 'Store'),
              state: await readFile(run.opts.statePath, 'utf8'),
              journal: await readFile(run.opts.statePath.replace(/\.json$/, '.journal'), 'utf8'),
            }
            for (const [where, text] of Object.entries(written)) {
              for (const secret of SECRETS) expect(text, `${where} names ${secret}`).not.toContain(secret)
            }
          } finally {
            await run.env.close()
          }
        },
      ),
      {
        numRuns: 20,
        examples: [
          [sources.map(() => 'stored' as const)],
          [sources.map((_, i) => (['http404', 'html', 'internal'] as const)[i % 3]!)],
          [sources.map((_, i) => (['credentialed', 'expired', 'stored'] as const)[i % 3]!)],
        ],
      },
    )
  }, 120_000)

  it('AC-1: an import stopped after its first product create and resumed reports the media warnings of an import never stopped, each once, in its report and its state file', async () => {
    // Every product's second image is missing, so each product has one warning to keep across the stop.
    const outcomes = sources.map((_, i) => (i % 3 === 1 ? 'http404' : 'stored') as Outcome)

    const whole = await runImport(outcomes)
    let expected: string[]
    try {
      expected = mediaWarnings((await runWooCommerceImport(whole.opts, whole.deps)).warnings)
        .map(key)
        .sort()
    } finally {
      await whole.env.close()
    }
    expect(expected.length).toBe(catalogue.products.length)

    let reached!: () => void
    const stopped = new Promise<void>((resolve) => (reached = resolve))
    const run = await runImport(outcomes, (services) => {
      let creates = 0
      const product = new Proxy(services.product, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown
          if (typeof value !== 'function') return value
          const bound = (value as (...a: unknown[]) => Promise<unknown>).bind(target)
          if (prop !== 'create') return bound
          return (...args: unknown[]) => {
            if (++creates > 1) {
              reached()
              return new Promise(() => undefined)
            }
            return bound(...args)
          }
        },
      })
      return { ...services, product } as ServiceRegistry
    })
    try {
      const first = runWooCommerceImport(run.opts, { ...run.deps, services: run.stopping! })
      first.catch(() => undefined)
      await Promise.race([stopped, first])

      const resumed = await runWooCommerceImport({ ...run.opts, fresh: false }, run.deps)

      expect(mediaWarnings(resumed.warnings).map(key).sort()).toEqual(expected)
      const state = JSON.parse(await readFile(run.opts.statePath, 'utf8')) as {
        warnings: Warning[]
      }
      expect(mediaWarnings(state.warnings).map(key).sort()).toEqual(expected)
    } finally {
      await run.env.close()
    }
  }, 120_000)
})
