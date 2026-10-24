import { spawn, type ChildProcess } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { seedProducts } from '../../../packages/platform/src/seed/data'
import { cardSlugs } from '../support/elements'
import { blockExternalRequests, expect, test } from '../support/fixtures'

// P2-19 AC-6 (spec P2-19-fragments-and-isr, Decisions 5, 6 and 7, Interface "AC-6's harness"; playwright.isr.config.ts):
// no empty page is baked in. A Next build made while NYMBAL_API_URL points at a port nothing listens on exits 0, and
// its `GET /no-such-page` answers 404 with the site header. Its `next start` (window NYMBAL_CATALOG_REVALIDATE_S=2)
// against a live API serves `/` with `GET /api/products?limit=8`'s eight cards on the first request, and
// `/product/<seed slug>` with its product. With the API stopped and the window passed (Next no longer answers HIT),
// both still answer 200 with the same cards and product, twice in a row.
// Kills: a build that fails without an API (a static page, or the root layout with `/_not-found` under it, made a
// catalog fetch at build); a build that prerendered `/` empty and serves it; a `fetchProduct` that turned the build-time
// or down-API failure into a cached `notFound()`; a failed regeneration that replaced the good page with an empty grid
// or the seed categories.

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const NEXT_DIR = fileURLToPath(new URL('../../../templates/nextjs/', import.meta.url))
const NEXT_BIN = fileURLToPath(
  new URL('../../../templates/nextjs/node_modules/next/dist/bin/next', import.meta.url),
)
const CLI_BIN = fileURLToPath(new URL('../../../packages/cli/bin/nymbal.mjs', import.meta.url))
const DIST_DIR = '.next-isr'
const WINDOW_S = '2'

const apiPort = Number(process.env.NYMBAL_ISR_API_PORT)
const nextPort = Number(process.env.NYMBAL_ISR_NEXT_PORT)
const sqlitePath = process.env.NYMBAL_ISR_SQLITE_PATH ?? ''
const API = `http://localhost:${apiPort}`
const PRODUCT = seedProducts[0]!.slug

interface Proc {
  name: string
  child: ChildProcess
  output: string[]
  exited: Promise<number | null>
}

const running: Proc[] = []

/** Starts a process in its own group, keeping the tail of its output for a failure's message. */
function start(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Proc {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output: string[] = []
  const keep = (chunk: Buffer) => {
    output.push(...chunk.toString('utf8').split('\n'))
    if (output.length > 200) output.splice(0, output.length - 200)
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  const proc = { name, child, output, exited }
  running.push(proc)
  return proc
}

/** SIGTERM to the process group, SIGKILL ten seconds later; resolves once it has exited. */
async function stop(proc: Proc): Promise<void> {
  const index = running.indexOf(proc)
  if (index >= 0) running.splice(index, 1)
  if (proc.child.exitCode !== null || proc.child.signalCode !== null) return
  const group = (signal: NodeJS.Signals) => {
    try {
      process.kill(-proc.child.pid!, signal)
    } catch {
      // The group is already gone.
    }
  }
  group('SIGTERM')
  const killer = setTimeout(() => group('SIGKILL'), 10_000)
  await proc.exited
  clearTimeout(killer)
}

const tail = (proc: Proc): string => proc.output.slice(-40).join('\n')

/** A port nothing listens on: one the OS just handed out and took back. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() =>
        typeof address === 'object' && address !== null
          ? resolve(address.port)
          : reject(new Error('no port')),
      )
    })
  })
}

/** The status `url` answers, or 0 when nothing answers. */
async function statusOf(url: string): Promise<number> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(5_000) })).status
  } catch {
    return 0
  }
}

function startApi(): Proc {
  return start('api', [CLI_BIN, 'dev', '--api-only', '--port', String(apiPort)], REPO, {
    ...process.env,
    NYMBAL_SQLITE_PATH: sqlitePath,
    NYMBAL_CORS_ORIGINS: `http://localhost:${nextPort}`,
  })
}

const contexts: BrowserContext[] = []

test.afterAll(async () => {
  for (const context of contexts.splice(0)) await context.close()
  for (const proc of [...running].reverse()) await stop(proc)
  rmSync(`${NEXT_DIR}${DIST_DIR}`, { recursive: true, force: true })
  for (const suffix of ['', '-wal', '-shm', '-journal'])
    rmSync(`${sqlitePath}${suffix}`, { force: true })
})

async function scriptOff(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL })
  contexts.push(context)
  return context
}

async function visit(
  context: BrowserContext,
  path: string,
): Promise<{ page: Page; status: number }> {
  const page = await context.newPage()
  await blockExternalRequests(page)
  const response = await page.goto(path)
  return { page, status: response?.status() ?? 0 }
}

/** What `/` and the product page show: the home grid's card slugs and the PDP's title. */
async function shown(context: BrowserContext) {
  const home = await visit(context, '/')
  const pdp = await visit(context, `/product/${PRODUCT}`)
  const result = {
    homeStatus: home.status,
    cards:
      home.status === 200 ? await cardSlugs(home.page.locator('main nymbal-product-grid')) : [],
    productStatus: pdp.status,
    title:
      pdp.status === 200
        ? ((await pdp.page.getByTestId('product-title').first().textContent()) ?? '').trim()
        : '',
  }
  await home.page.close()
  await pdp.page.close()
  return result
}

test.describe('P2-19 AC-6: no empty page is baked in (Next, built with no API)', () => {
  test('AC-6: caching.next-isr: a build with no API exits 0 and its 404 has the site header; next start serves the API’s eight cards on / and the product on its page, and keeps both, twice, once the API is down and the window has passed', async ({
    browser,
    request,
  }) => {
    expect(Number.isInteger(apiPort) && Number.isInteger(nextPort), 'the isr config’s ports').toBe(
      true,
    )
    const baseURL = `http://localhost:${nextPort}`
    rmSync(`${NEXT_DIR}${DIST_DIR}`, { recursive: true, force: true })

    await test.step('next build with NYMBAL_API_URL at a closed port exits 0', async () => {
      const dead = `http://localhost:${await closedPort()}`
      expect(await statusOf(`${dead}/health`), `nothing listens on ${dead}`).toBe(0)
      expect(await statusOf(`${API}/health`), `nothing listens on ${API} during the build`).toBe(0)
      const build = start('next build', [NEXT_BIN, 'build'], NEXT_DIR, {
        ...process.env,
        NYMBAL_NEXT_DIST_DIR: DIST_DIR,
        NYMBAL_API_URL: dead,
        NEXT_PUBLIC_NYMBAL_API_URL: API,
        // The window is read wherever the fetchers read it; the build prerenders no catalog page.
        NYMBAL_CATALOG_REVALIDATE_S: WINDOW_S,
        NEXT_TELEMETRY_DISABLED: '1',
      })
      const code = await build.exited
      await stop(build)
      expect(code, `next build with no API:\n${tail(build)}`).toBe(0)
    })

    const api = startApi()
    await expect
      .poll(() => statusOf(`${API}/health`), { timeout: 90_000, message: `the API:\n${tail(api)}` })
      .toBe(200)
    const next = start('next start', [NEXT_BIN, 'start', '-p', String(nextPort)], NEXT_DIR, {
      ...process.env,
      NYMBAL_NEXT_DIST_DIR: DIST_DIR,
      NYMBAL_API_URL: API,
      NEXT_PUBLIC_NYMBAL_API_URL: API,
      NYMBAL_CATALOG_REVALIDATE_S: WINDOW_S,
      NEXT_TELEMETRY_DISABLED: '1',
    })
    await expect
      .poll(() => statusOf(`${baseURL}/_next/static/p2-19-ready`), {
        timeout: 60_000,
        message: `next start:\n${tail(next)}`,
      })
      .toBeGreaterThan(0)

    const off = await scriptOff(browser, baseURL)

    await test.step('GET /no-such-page answers 404 with the site header', async () => {
      const { page, status } = await visit(off, '/no-such-page')
      expect(status).toBe(404)
      await expect(page.locator('nymbal-site-header')).toHaveCount(1)
      await page.close()
    })

    const products = await request.get(`${API}/api/products?limit=8`)
    expect(products.status()).toBe(200)
    const eight = (
      (await products.json()) as { data: { items: Array<{ slug: string }> } }
    ).data.items.map((p) => p.slug)
    expect(eight.length, 'the API’s featured products').toBe(8)
    const productRes = await request.get(`${API}/api/products/${PRODUCT}`)
    expect(productRes.status()).toBe(200)
    const name = ((await productRes.json()) as { data: { name: string } }).data.name
    const live = { homeStatus: 200, cards: eight, productStatus: 200, title: name }

    await test.step('with the API up, the first requests show the API’s cards and product', async () => {
      expect(await shown(off)).toEqual(live)
    })

    await test.step('with the API stopped and the window passed, both pages keep them, twice in a row', async () => {
      await stop(api)
      expect(await statusOf(`${API}/health`), 'the API is down').toBe(0)
      for (const path of ['/', `/product/${PRODUCT}`]) {
        await expect
          .poll(
            async () =>
              (await request.get(`${baseURL}${path}`)).headers()['x-nextjs-cache'] ?? 'none',
            {
              timeout: 30_000,
              message: `${path}: Next stops answering HIT once the ${WINDOW_S} s window has passed`,
            },
          )
          .not.toBe('HIT')
      }
      const first = await shown(off)
      const second = await shown(off)
      expect({ first, second }).toEqual({ first: live, second: live })
    })
  })
})
