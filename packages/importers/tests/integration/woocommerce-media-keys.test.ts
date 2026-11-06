import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWooCommerceImport, type WooCommerceImporterDeps } from '@nymbalhq/importers'
import type { MediaStorage } from '@nymbalhq/types'
import {
  buildImportEnv,
  importOptions,
  offlineLookup,
  sourceCatalogue,
  WC_URL,
  wooFetch,
  type SourceImage,
} from './support/import-env.js'

// A WooCommerce slug is the store's input, not a path: every media key the importer puts is
// `products/<slug>/<file>`, `<slug>` the slug of the product it created, with no `..`, no further `/` inside the slug
// and no `\`, whatever the WooCommerce slug held. Runs against the built dist (`pnpm build`).

interface Put {
  key: string
  body: Uint8Array
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/** Three simple products whose WooCommerce slugs try to leave the media root, each with one image of its own. */
function hostileCatalogue(): ReturnType<typeof sourceCatalogue> {
  const base = sourceCatalogue(1)
  const template = base.wcProducts.find((p) => p['type'] === 'simple')!
  const shapes = [
    { id: 300, slug: '../../../../tmp/x', name: 'Traversal Tee' },
    { id: 301, slug: 'a/b', name: 'Slash Tee' },
    { id: 302, slug: '', name: 'Ünïcode Tee' },
  ]
  const images = new Map<string, SourceImage>()
  const products = []
  const wcProducts = shapes.map((shape) => {
    const src = `${WC_URL}/img/${shape.id}-1.jpg`
    const image = {
      src,
      bytes: new TextEncoder().encode(`media key image ${shape.id}\n`),
      contentType: 'image/jpeg',
    }
    images.set(src, image)
    products.push({ id: shape.id, slug: shape.slug, images: [image] })
    return {
      ...template,
      ...shape,
      sku: `KEY-${shape.id}`,
      images: [{ id: shape.id * 100, src, name: `${shape.id}`, alt: shape.name }],
    }
  })
  return { products, wcProducts, images }
}

let tmpDir: string
const realFetch = globalThis.fetch
const catalogue = hostileCatalogue()
const envs: Array<Awaited<ReturnType<typeof buildImportEnv>>> = []

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'import-media-keys-'))
  vi.stubGlobal('fetch', wooFetch(catalogue, realFetch))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const env of envs.splice(0)) await env.close()
  await rm(tmpDir, { recursive: true, force: true })
})

describe('AC-12: media keys stay under products/<slug>/', () => {
  it('AC-12: products imported with slugs ../../../../tmp/x, a/b and empty each have every media key start with products/<the created product’s slug>/ and hold no .., no / inside the slug and no backslash', async () => {
    const puts: Put[] = []
    const media: MediaStorage = {
      capabilities: () => ['put'],
      async put(key, body) {
        puts.push({ key, body: new Uint8Array(body) })
        return { url: `/imported-media/${key}` }
      },
    }
    const env = await buildImportEnv()
    envs.push(env)
    const opts = importOptions(tmpDir)
    const deps: WooCommerceImporterDeps = {
      services: env.services,
      repos: env.repos,
      adapters: env.adapters,
      media,
      lookup: offlineLookup,
    }

    const report = await runWooCommerceImport(opts, deps)
    const state = JSON.parse(await readFile(opts.statePath, 'utf8')) as {
      wcToNymbalProduct: Record<string, string>
    }
    const slugOf = new Map<number, string>()
    for (const [wcId, id] of Object.entries(state.wcToNymbalProduct)) {
      slugOf.set(Number(wcId), (await env.services.product.getById(id)).slug)
    }
    const owner = (put: Put): number =>
      catalogue.products.find((p) => p.images.some((i) => hex(i.bytes) === hex(put.body)))!.id

    expect(report.errors).toEqual([])
    expect([...slugOf.keys()].sort()).toEqual(catalogue.products.map((p) => p.id).sort())
    expect(puts.map((p) => owner(p)).sort()).toEqual(catalogue.products.map((p) => p.id).sort())
    for (const put of puts) {
      const slug = slugOf.get(owner(put))!
      const prefix = `products/${slug}/`
      expect(put.key.startsWith(prefix), `${put.key} under ${prefix}`).toBe(true)
      expect(put.key.slice(prefix.length).includes('/'), put.key).toBe(false)
      expect(/\.\.|\\/.test(put.key), put.key).toBe(false)
      expect(/\/|\.\.|\\/.test(slug), slug).toBe(false)
    }
  })
})
