import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closedPort, runCli } from '../support/doctor.js'
import {
  NEXT_START_FIXTURE,
  PUBLIC_URL,
  send,
  spawnStart,
  startEnv,
  storeConfig,
  storeProject,
  untilServing,
  type StartRun,
  type StoreProject,
} from '../support/start.js'

// AC-6 on both built templates: `nymbal start` on a PORT that is not 3001 with the storefront built as the image
// builds it (an empty public API URL) and its server-side API URL baked at a closed port, so a page renders only when
// the child reads NYMBAL_API_URL at run time. Through the one port: the storefront's server-rendered pages with the
// API's products, the API's JSON and JSON 404, the admin, the storefront's own 404; canonical URLs on the configured
// public origin whatever Host the client sends (Astro); a Next server action posted with that origin; and no script
// that names localhost:3001. The built entry is given through NYMBAL_STOREFRONT_ENTRY (Astro's dist/server/entry.mjs;
// Next's `next start`, through tests/fixtures/storefront/next-start.mjs). Builds both templates (minutes) and the CLI.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TEMPLATE_DIR = {
  astro: join(REPO, 'templates', 'astro'),
  nextjs: join(REPO, 'templates', 'nextjs'),
}
const BUILD_MS = 600_000
const READY_MS = 90_000

const address = {
  firstName: 'Start',
  lastName: 'Proof',
  addressLine1: '1 Port Street',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (b: Buffer) => (out += b.toString()))
    child.stderr.on('data', (b: Buffer) => (out += b.toString()))
    child.once('exit', (code) => resolve({ code, out }))
  })
}

/** Builds `template` as the image does, beside the checkout's own build, and returns the entry `start` is given. */
async function buildStorefront(template: 'astro' | 'nextjs', scratch: string[]): Promise<string> {
  const dir = TEMPLATE_DIR[template]
  const deadApi = `http://127.0.0.1:${await closedPort()}`
  const env = { ...process.env, NYMBAL_API_URL: deadApi, NEXT_TELEMETRY_DISABLED: '1' }
  if (template === 'astro') {
    // Inside the template's node_modules, so the server bundle resolves the template's dependencies.
    const out = join(dir, 'node_modules', '.cache', `nymbal-start-${process.pid}`)
    scratch.push(out)
    const built = await run(
      join(dir, 'node_modules', '.bin', 'astro'),
      ['build', '--outDir', out],
      dir,
      {
        ...env,
        PUBLIC_NYMBAL_API_URL: '',
      },
    )
    if (built.code !== 0)
      throw new Error(`astro build exited ${built.code}:\n${built.out.slice(-3000)}`)
    return join(out, 'server', 'entry.mjs')
  }
  const distDir = `.next-start-${process.pid}`
  scratch.push(join(dir, distDir))
  const built = await run(join(dir, 'node_modules', '.bin', 'next'), ['build'], dir, {
    ...env,
    NYMBAL_NEXT_DIST_DIR: distDir,
    NEXT_PUBLIC_NYMBAL_API_URL: '',
  })
  if (built.code !== 0)
    throw new Error(`next build exited ${built.code}:\n${built.out.slice(-3000)}`)
  const launcher = mkdtempSync(join(tmpdir(), 'next-start-'))
  scratch.push(launcher)
  copyFileSync(NEXT_START_FIXTURE, join(launcher, 'next-start.mjs'))
  writeFileSync(join(launcher, 'next-start.json'), JSON.stringify({ dir, distDir }))
  return join(launcher, 'next-start.mjs')
}

/** A cookie-carrying API client on the store's one port, with the double-submit CSRF token the config demands. */
function apiClient(base: string) {
  const csrf = randomBytes(32).toString('hex')
  const jar = new Map<string, string>([['nymbal.csrf', csrf]])
  return async function api<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(new URL(path, base), {
      method,
      headers: {
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        'x-csrf-token': csrf,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    for (const set of res.headers.getSetCookie()) {
      const [pair] = set.split(';')
      const eq = pair!.indexOf('=')
      if (eq > 0) jar.set(pair!.slice(0, eq).trim(), pair!.slice(eq + 1).trim())
    }
    const text = await res.text()
    return { status: res.status, data: (text ? (JSON.parse(text) as { data?: T }) : {}).data as T }
  }
}

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** The href of the page's `<link rel="canonical">`. */
function canonicalOf(html: string): string | undefined {
  const link = /<link\b[^>]*\brel="canonical"[^>]*>/.exec(html)?.[0]
  const href = link === undefined ? undefined : /\bhref="([^"]*)"/.exec(link)?.[1]
  return href === undefined ? undefined : decode(href)
}

/** Every script, module preload and Astro island URL a page loads. */
function scriptUrls(html: string): string[] {
  const urls = [
    ...[...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]!),
    ...[...html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/g)].map(
      (m) => m[1]!,
    ),
    ...[...html.matchAll(/\b(?:component|renderer)-url="([^"]+)"/g)].map((m) => m[1]!),
  ]
  return [...new Set(urls.map(decode))]
}

interface ProductDoc {
  slug: string
  name: string
  variants?: Array<{ id: string; stock: number }>
}

for (const template of ['astro', 'nextjs'] as const) {
  describe(`AC-6: nymbal start with the built ${template} storefront`, () => {
    const scratch: string[] = []
    let project: StoreProject
    let store: StartRun
    let products: ProductDoc[] = []

    beforeAll(async () => {
      const entry = await buildStorefront(template, scratch)
      project = storeProject(storeConfig({}, template))
      const env = startEnv({ NYMBAL_STOREFRONT_ENTRY: entry, NYMBAL_PUBLIC_URL: PUBLIC_URL })
      for (const step of [['migrate'], ['seed']]) {
        const done = await runCli(step, { cwd: project.dir, env, timeoutMs: 120_000 })
        if (done.code !== 0)
          throw new Error(`nymbal ${step[0]} exited ${done.code}:\n${done.out.slice(-2000)}`)
      }
      store = await spawnStart(['start'], { cwd: project.dir, env })
      await untilServing(store, READY_MS)
      const deadline = Date.now() + READY_MS
      while (Date.now() < deadline) {
        const status = await send(`${store.base}/`).then(
          (r) => r.status,
          () => 0,
        )
        if (status === 200) break
        await new Promise((r) => setTimeout(r, 250))
      }
      const listing = (await (await fetch(`${store.base}/api/products?limit=100`)).json()) as {
        data: { items: ProductDoc[] }
      }
      products = listing.data.items
    }, BUILD_MS)

    afterAll(async () => {
      await store?.kill()
      project?.remove()
      for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
    })

    it(`AC-6: ${template}: on a port other than 3001, GET / is the storefront's server-rendered HTML showing products the API lists`, async () => {
      const home = await send(`${store.base}/`)
      const html = home.body.toString()
      const shown = products.filter((p) => html.includes(p.name) || html.includes(decode(p.name)))

      expect(store.port).not.toBe(3001)
      expect(home.status, html.slice(0, 500)).toBe(200)
      expect(home.headers['content-type']).toMatch(/^text\/html/)
      expect(shown.length, `none of ${products.length} API products on GET /`).toBeGreaterThan(0)
    })

    it(`AC-6: ${template}: /api/products is the API's JSON, /api/nope the API's JSON 404, /admin the API's 308 to /admin/ and /admin/ the admin, and a missing page keeps the storefront's 404`, async () => {
      const api = await send(`${store.base}/api/products?limit=100`)
      const nope = await send(`${store.base}/api/nope`)
      const admin = await send(`${store.base}/admin`)
      const adminIndex = await send(`${store.base}/admin/`)
      const missing = await send(`${store.base}/no-such-page-${randomBytes(4).toString('hex')}`)

      expect(api.headers['content-type']).toMatch(/^application\/json/)
      expect(
        (JSON.parse(api.body.toString()) as { data: { items: ProductDoc[] } }).data.items.map(
          (p) => p.slug,
        ),
      ).toEqual(products.map((p) => p.slug))
      expect(nope.status).toBe(404)
      expect(nope.headers['content-type']).toMatch(/^application\/json/)
      expect(admin.status).toBe(308)
      expect(admin.headers['location']).toBe('/admin/')
      expect(adminIndex.body.toString()).toContain('data-admin-stand-in="nymbal-start"')
      expect(missing.status).toBe(404)
      expect(missing.headers['content-type']).toMatch(/^text\/html/)
    })

    it(`AC-6: ${template}: no script the home and product pages load names localhost:3001`, async () => {
      const pages = [`${store.base}/`, `${store.base}/product/${products[0]!.slug}`]
      const html = await Promise.all(pages.map(async (url) => (await send(url)).body.toString()))
      const urls = [...new Set(html.flatMap(scriptUrls))]
      const fetched = await Promise.all(
        urls.map(async (src) => {
          const res = await send(new URL(src, store.base).toString())
          return { src, status: res.status, text: res.body.toString() }
        }),
      )

      expect(urls.length, 'the pages load scripts').toBeGreaterThan(0)
      expect(fetched.filter((f) => f.status !== 200).map((f) => `${f.status} ${f.src}`)).toEqual([])
      expect(
        [...html, ...fetched.map((f) => f.text)].filter((text) => text.includes('localhost:3001')),
      ).toEqual([])
    })

    if (template === 'astro') {
      it('AC-6: astro: with NYMBAL_PUBLIC_URL=https://shop.example, the product page canonical is https://shop.example/product/<slug> and a keyed order page canonical is https://shop.example/order/<n>, whatever Host the client sent', async () => {
        const slug = products[0]!.slug
        const product = await send(`${store.base}/product/${slug}`, {
          headers: { host: 'evil.example' },
        })
        const api = apiClient(store.base)
        const buyable = products.find((p) => (p.variants?.[0]?.stock ?? 0) >= 1)!
        const added = await api('POST', '/api/cart/items', {
          variantId: buyable.variants![0]!.id,
          qty: 1,
        })
        const checkout = await api<{ orderNumber: string; orderKey: string }>(
          'POST',
          '/api/checkout',
          {
            email: `start-${randomBytes(4).toString('hex')}@nymbal.dev`,
            billingAddress: address,
            shippingAddress: address,
          },
        )
        const order = await send(
          `${store.base}/order/${checkout.data.orderNumber}?key=${encodeURIComponent(checkout.data.orderKey)}`,
          { headers: { host: 'evil.example' } },
        )

        expect(product.status).toBe(200)
        expect(canonicalOf(product.body.toString())).toBe(`${PUBLIC_URL}/product/${slug}`)
        expect(added.status).toBe(200)
        expect(checkout.status).toBe(200)
        expect(order.status, order.body.toString().slice(0, 500)).toBe(200)
        expect(order.body.toString()).toContain(checkout.data.orderNumber)
        expect(canonicalOf(order.body.toString())).toBe(
          `${PUBLIC_URL}/order/${checkout.data.orderNumber}`,
        )
      })
    }

    if (template === 'nextjs') {
      it('AC-6: nextjs: the alerts confirm server action, posted through the port with Origin https://shop.example, runs instead of being refused, and answers with the invalid-link state for an unknown token', async () => {
        const url = `${store.base}/alerts/confirm?token=t${randomBytes(8).toString('hex')}`
        const page = await send(url)
        const form =
          /<form\b[^>]*data-testid="alert-confirm-form"[^>]*>([\s\S]*?)<\/form>/.exec(
            page.body.toString(),
          )?.[1] ?? ''
        const body = new FormData()
        for (const input of form.matchAll(/<input\b([^>]*)>/g)) {
          const name = /\bname="([^"]*)"/.exec(input[1]!)?.[1]
          const value = /\bvalue="([^"]*)"/.exec(input[1]!)?.[1] ?? ''
          if (name !== undefined) body.append(decode(name), decode(value))
        }

        const posted = await fetch(url, { method: 'POST', body, headers: { origin: PUBLIC_URL } })
        const html = await posted.text()

        expect(page.status).toBe(200)
        expect([...body.keys()]).toContain('token')
        expect(posted.status, html.slice(0, 500)).toBe(200)
        expect(html).toContain('data-testid="alert-link-invalid"')
        expect(html).not.toContain('data-testid="alert-confirm-form"')
      })
    }
  })
}
