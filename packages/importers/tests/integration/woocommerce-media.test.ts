import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWooCommerceImport, type WooCommerceImporterDeps } from '@nymbalhq/importers'
import type { MediaStorage } from '@nymbalhq/types'
import {
  buildImportEnv,
  importedMedia,
  importOptions,
  sourceCatalogue,
  wooFetch,
  type SourceImage,
} from './support/import-env.js'

// AC-4: the WooCommerce importer writes to the media storage it is given in `deps.media` and builds none of its own;
// a failed put for one image still creates the product and is reported in errors and as an `error` event. The fake's
// URLs carry a put counter, so a URL the importer computed itself cannot match. The S3 case is
// tests/stores/woocommerce-import-s3.test.ts. Runs against the built dist (`pnpm build`).

interface Put {
  key: string
  body: Uint8Array
  contentType: string
  url: string
}

/** A media storage that records every put and answers a URL no key-based rule could produce. */
function recordingMedia(rejectFor?: (body: Uint8Array) => boolean) {
  const puts: Put[] = []
  let n = 0
  const media: MediaStorage = {
    capabilities: () => ['put'],
    async put(key, body, contentType) {
      if (rejectFor?.(body)) throw new Error('s3: the bucket refused this object')
      n++
      const url = `https://fake-media.s3.test/${n}/${key}`
      puts.push({ key, body: new Uint8Array(body), contentType, url })
      return { url }
    },
  }
  return { media, puts }
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/** The URL put returned for the image whose bytes these are. */
function urlFor(puts: Put[], image: SourceImage): string | undefined {
  return puts.find((p) => hex(p.body) === hex(image.bytes))?.url
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
}

let tmpDir: string
const realFetch = globalThis.fetch
const catalogue = sourceCatalogue(3)
const envs: Array<Awaited<ReturnType<typeof buildImportEnv>>> = []

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 's3-import-media-'))
  vi.stubGlobal('fetch', wooFetch(catalogue, realFetch))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const env of envs.splice(0)) await env.close()
  await rm(tmpDir, { recursive: true, force: true })
})

async function runImport(media: MediaStorage) {
  const env = await buildImportEnv()
  envs.push(env)
  const events: Array<{ kind: string; phase?: string; id?: string }> = []
  const opts = importOptions(tmpDir)
  const deps: WooCommerceImporterDeps = {
    services: env.services,
    repos: env.repos,
    adapters: env.adapters,
    media,
    onProgress: (event) => events.push(event as (typeof events)[number]),
  }
  const report = await runWooCommerceImport(opts, deps)
  return { report, events, media: await importedMedia(env, opts.statePath) }
}

describe('AC-4: the importer writes to the media it is given', () => {
  it('AC-4: every image goes to deps.media, each product’s media URLs are what its puts returned, in order, and nothing is written under public/imported-media', async () => {
    const { media, puts } = recordingMedia()

    const { report, media: imported } = await runImport(media)

    expect(report.errors).toEqual([])
    expect(report.imported.products).toBe(catalogue.products.length)
    // Every source image, and nothing else, was put, with the content type its source served.
    expect(puts.map((p) => hex(p.body)).sort()).toEqual(
      [...catalogue.images.values()].map((i) => hex(i.bytes)).sort(),
    )
    for (const image of catalogue.images.values()) {
      expect(puts.find((p) => hex(p.body) === hex(image.bytes))?.contentType, image.src).toBe(
        image.contentType,
      )
    }
    expect(imported.size).toBe(catalogue.products.length)
    for (const product of catalogue.products) {
      expect(imported.get(product.id), `product ${product.id}`).toEqual(
        product.images.map((image) => urlFor(puts, image)),
      )
    }
    expect(filesUnder(join(tmpDir, 'public', 'imported-media'))).toEqual([])
  })

  it('AC-4: a put that rejects for one image is reported, not dropped: the product keeps its other images, errors holds one { phase: media, id }, and an error event matches it', async () => {
    const [victim, other] = catalogue.products
    const failing = victim!.images[1]!
    const { media, puts } = recordingMedia((body) => hex(body) === hex(failing.bytes))

    const { report, events, media: imported } = await runImport(media)

    // The product is still created, with the images that stored, in their order.
    expect(report.imported.products).toBe(catalogue.products.length)
    const kept = victim!.images.filter((image) => image !== failing)
    expect(imported.get(victim!.id)).toEqual(kept.map((image) => urlFor(puts, image)))
    expect(imported.get(other!.id)).toEqual(other!.images.map((image) => urlFor(puts, image)))
    expect(puts.length).toBe(catalogue.images.size - 1)

    const mediaErrors = report.errors.filter((e) => e.phase === 'media')
    expect(mediaErrors.map((e) => String(e.id))).toEqual([String(victim!.id)])
    expect(mediaErrors[0]?.error).toContain('the bucket refused this object')
    expect(report.errors.length).toBe(mediaErrors.length)

    const mediaEvents = events.filter((e) => e.kind === 'error' && e.phase === 'media')
    expect(mediaEvents.map((e) => String(e.id))).toEqual(mediaErrors.map((e) => String(e.id)))
  })
})
