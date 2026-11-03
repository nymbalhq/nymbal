import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { blockExternalRequests, expect, test } from '../support/fixtures'

// The Next template's dev server with its API stopped. A shopper page whose own read degrades (/cart: no cart is shown
// as the loading shell) still renders, header and all, rather than the error page; a page that does need the API
// (/checkout: how to take a payment) shows the error page, and once the API is back its Try Again shows the page in
// the same document. The suite's own API cannot be stopped from a test, so this journey runs an API of its own and a
// `next dev` of its own, each on a free port, the dev server building into a directory of its own.

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const NEXT_DIR = fileURLToPath(new URL('../../../templates/nextjs/', import.meta.url))
const NEXT_BIN = join(NEXT_DIR, 'node_modules', 'next', 'dist', 'bin', 'next')
const CLI_BIN = join(REPO, 'packages', 'cli', 'bin', 'nymbal.mjs')
const DIST_DIR = `.next-api-down-${process.pid}`

const API_READY_MS = 30_000
const NEXT_READY_MS = 120_000
/** A first `next dev` compile of a page takes this long at most on a loaded runner. */
const COMPILE_MS = 90_000

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

const gone = (proc: Proc): boolean => proc.child.exitCode !== null || proc.child.signalCode !== null

/** SIGTERM to the process group, SIGKILL ten seconds later; resolves once it has exited. */
async function stop(proc: Proc): Promise<void> {
  const index = running.indexOf(proc)
  if (index >= 0) running.splice(index, 1)
  if (gone(proc)) return
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

function freePort(): Promise<number> {
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

/** The status `url` answers, or 0 when nothing answers within `ms`. */
async function statusOf(url: string, ms: number): Promise<number> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(ms) })).status
  } catch {
    return 0
  }
}

/** Waits until `url` answers `ok`, failing with the process's output when it exits or the bound passes. */
async function answering(
  proc: Proc,
  url: string,
  ok: (status: number) => boolean,
  within: number,
): Promise<void> {
  const deadline = Date.now() + within
  while (Date.now() < deadline) {
    if (gone(proc)) throw new Error(`${proc.name} exited before ${url} answered:\n${tail(proc)}`)
    if (ok(await statusOf(url, Math.max(1_000, deadline - Date.now())))) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`${proc.name}: ${url} did not answer within ${within} ms:\n${tail(proc)}`)
}

let apiPort = 0
let nextPort = 0
let dataDir = ''
let api: Proc | undefined
let next: Proc | undefined
const contexts: BrowserContext[] = []

const apiBase = (): string => `http://localhost:${apiPort}`
const storeBase = (): string => `http://localhost:${nextPort}`

/** This journey's API on its port and database: the same store after a restart. */
async function startApi(): Promise<void> {
  api = start('api', [CLI_BIN, 'dev', '--api-only', '--port', String(apiPort)], REPO, {
    ...process.env,
    NYMBAL_SQLITE_PATH: join(dataDir, 'nymbal.db'),
    NYMBAL_CORS_ORIGINS: storeBase(),
  })
  await answering(api, `${apiBase()}/health`, (s) => s === 200, API_READY_MS)
}

async function stopApi(): Promise<void> {
  if (api !== undefined) await stop(api)
  expect(await statusOf(`${apiBase()}/health`, 2_000), 'the API is stopped').toBe(0)
}

async function shopper(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: storeBase() })
  contexts.push(context)
  const page = await context.newPage()
  await blockExternalRequests(page)
  return page
}

/** The store's own answer to whether it searches, which puts the search bar in the header while the API is up. */
async function searchBarsWhileUp(): Promise<number> {
  const res = await fetch(`${apiBase()}/api/capabilities`)
  expect(res.status, 'GET /api/capabilities').toBe(200)
  const { data } = (await res.json()) as { data: { search: { capabilities: string[] } } }
  return data.search.capabilities.includes('search') ? 1 : 0
}

const errorHeading = (page: Page) => page.getByRole('heading', { name: 'Something went wrong' })
const headerSearchBars = (page: Page) => page.locator('nymbal-site-header nymbal-search-bar')

/** Opens `/cart` and `/checkout` with the API up, so both are compiled and have rendered once. */
async function warm(page: Page): Promise<void> {
  for (const path of ['/cart', '/checkout']) {
    const res = await page.goto(path, { timeout: COMPILE_MS })
    expect(res?.status(), `GET ${path} with the API up`).toBe(200)
  }
}

test.describe('A Next shopper page with the API stopped', () => {
  test.describe.configure({ mode: 'default' })

  test.beforeAll(async () => {
    test.setTimeout(API_READY_MS + NEXT_READY_MS + 30_000)
    apiPort = await freePort()
    do nextPort = await freePort()
    while (nextPort === apiPort)
    dataDir = mkdtempSync(join(tmpdir(), 'nymbal-e2e-next-api-down-'))
    await startApi()
    next = start('next dev', [NEXT_BIN, 'dev', '-p', String(nextPort)], NEXT_DIR, {
      ...process.env,
      NYMBAL_API_URL: apiBase(),
      NEXT_PUBLIC_NYMBAL_API_URL: apiBase(),
      NYMBAL_NEXT_DIST_DIR: DIST_DIR,
    })
    await answering(next, `${storeBase()}/no-such-page`, (s) => s > 0, NEXT_READY_MS)
  })

  test.afterAll(async () => {
    for (const context of contexts.splice(0)) await context.close()
    for (const proc of [...running].reverse()) await stop(proc)
    rmSync(join(NEXT_DIR, DIST_DIR), { recursive: true, force: true })
    if (dataDir !== '') rmSync(dataDir, { recursive: true, force: true })
  })

  test.beforeEach(async () => {
    if (api === undefined || gone(api)) await startApi()
  })

  test('AC-2: with the API stopped, /cart answers 200 with its site header (no search bar) and its cart page, never the error page', async ({
    browser,
  }) => {
    test.setTimeout(3 * COMPILE_MS)
    const page = await shopper(browser)
    await warm(page)
    await page.goto('/cart')
    const searchBars = await searchBarsWhileUp()
    await expect(headerSearchBars(page), 'the header’s search bar while the API is up').toHaveCount(
      searchBars,
    )

    await stopApi()
    const res = await page.goto('/cart')
    expect(res?.status(), 'GET /cart with the API stopped').toBe(200)
    await expect(page.locator('nymbal-site-header')).toBeVisible()
    await expect(
      headerSearchBars(page),
      'the header’s search bar with the API stopped',
    ).toHaveCount(0)
    await expect(page.locator('nymbal-cart-page')).toHaveCount(1)
    await expect(errorHeading(page)).toBeHidden()
  })

  test('AC-3: with the API stopped /checkout shows the error page; once the same API is back, Try Again shows the checkout’s contact step in the same document', async ({
    browser,
  }) => {
    test.setTimeout(3 * COMPILE_MS)
    const page = await shopper(browser)
    await warm(page)
    await expect(
      page.getByTestId('checkout-contact'),
      'the contact step with the API up',
    ).toBeVisible()

    await stopApi()
    await page.goto('/checkout')
    await expect(errorHeading(page), '/checkout with the API stopped').toBeVisible({
      timeout: 30_000,
    })
    const originBefore = await page.evaluate(() => {
      ;(window as unknown as { __sameDocument?: string }).__sameDocument = 'before Try Again'
      return performance.timeOrigin
    })

    await startApi()
    // A plain click, so a press the dev overlay intercepts fails here rather than passing by force.
    await page.getByTestId('error-retry').click({ timeout: 10_000 })
    await expect(
      page.getByTestId('checkout-contact'),
      'the contact step after Try Again',
    ).toBeVisible({
      timeout: 30_000,
    })
    await expect(errorHeading(page)).toBeHidden()
    const marker = await page.evaluate(
      () =>
        (window as unknown as { __sameDocument?: string }).__sameDocument ??
        'gone: the page reloaded',
    )
    expect(marker, 'the window marker set before the press').toBe('before Try Again')
    // A reload starts a new document, whose time origin is later than the error page's.
    expect(
      await page.evaluate(() => performance.timeOrigin),
      'the document’s time origin',
    ).toBeLessThanOrEqual(originBefore)
  })
})
