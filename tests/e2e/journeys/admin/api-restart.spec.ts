import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { csrf } from '../../support/csrf'
import {
  SHIPPING_ADDRESS,
  realtimeConnected,
  signInAsAdmin,
  watchRealtime,
} from '../../support/admin'

// AC-4: a merchant with the orders list open stops and restarts the API, and the tab picks up where it was and sees
// the next order. The suite's own API cannot be restarted from a test, so this journey runs one of its own on a free
// port and a database of its own.

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const CLI_BIN = join(REPO_ROOT, 'packages', 'cli', 'bin', 'nymbal.mjs')
const ADMIN_DIST = join(REPO_ROOT, 'apps', 'admin', 'dist')

const EXIT_WITHIN_MS = 3000
const READY_WITHIN_MS = 30_000
/** The admin's backoff after an outage is 1, 2, 5, 10 s; a tab not back by then is not coming back. */
const RECONNECT_WITHIN_MS = 45_000
const ORDER_WITHIN_MS = 10_000

const path = (url: string): string => new URL(url).pathname

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

interface Api {
  child: ChildProcess
  exited: Promise<number | null>
  isGone: () => boolean
  output: () => string
}

/** `nymbal dev --api-only --port <port>` on `sqlitePath`, answering `/health` before this returns. */
async function startApi(port: number, sqlitePath: string): Promise<Api> {
  const child = spawn(process.execPath, [CLI_BIN, 'dev', '--api-only', '--port', String(port)], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NYMBAL_SQLITE_PATH: sqlitePath,
      NYMBAL_ADMIN_DIST: ADMIN_DIST,
      NYMBAL_PAYMENTS_PROVIDER: 'native-stub',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout?.on('data', (b: Buffer) => (out += b.toString()))
  child.stderr?.on('data', (b: Buffer) => (out += b.toString()))
  let gone = false
  const exited = new Promise<number | null>((r) =>
    child.once('exit', (code) => {
      gone = true
      r(code)
    }),
  )
  const api: Api = { child, exited, isGone: () => gone, output: () => out }

  const deadline = Date.now() + READY_WITHIN_MS
  while (Date.now() < deadline && !gone) {
    const up = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(1000) })
      .then((r) => r.ok)
      .catch(() => false)
    if (up) return api
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!gone) child.kill('SIGKILL')
  throw new Error(
    `nymbal dev --api-only --port ${port} did not answer GET /health on :${port} within ${READY_WITHIN_MS} ms` +
      ` (${gone ? 'it exited' : 'still running'}). Output:\n${out.slice(-2000)}`,
  )
}

/** Ms from SIGTERM to the process's exit, or `Infinity` when it is still alive `EXIT_WITHIN_MS + 2000` later. */
async function sigtermAndTime(api: Api): Promise<number> {
  const sentAt = Date.now()
  api.child.kill('SIGTERM')
  let timer: ReturnType<typeof setTimeout> | undefined
  const gaveUp = new Promise<'alive'>((r) => {
    timer = setTimeout(() => r('alive'), EXIT_WITHIN_MS + 2000)
  })
  const result = await Promise.race([api.exited.then(() => 'exited' as const), gaveUp])
  clearTimeout(timer)
  return result === 'exited' ? Date.now() - sentAt : Number.POSITIVE_INFINITY
}

function connectedCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __nymbalSseConnected?: number }).__nymbalSseConnected ?? 0,
  )
}

/** A pending order through this journey's own API: a seeded in-stock variant into a cart, then checkout (native stub). */
async function placeOrderOn(
  request: APIRequestContext,
  base: string,
): Promise<{ orderNumber: string }> {
  const productsRes = await request.get(`${base}/api/products?limit=50`)
  expect(productsRes.ok(), 'GET /api/products').toBe(true)
  const products = (
    (await productsRes.json()) as {
      data: { items: Array<{ variants?: Array<{ id: string; stock?: number }> }> }
    }
  ).data.items
  let added = false
  for (const product of products) {
    const variant = product.variants?.find((v) => (v.stock ?? 1) > 0)
    if (!variant) continue
    const addRes = await request.post(`${base}/api/cart/items`, {
      headers: await csrf(request, base),
      data: { variantId: variant.id, qty: 1 },
    })
    if (addRes.ok()) {
      added = true
      break
    }
  }
  expect(added, 'a seeded in-stock variant added to the cart').toBe(true)

  const checkoutRes = await request.post(`${base}/api/checkout`, {
    headers: await csrf(request, base),
    data: {
      email: `e2e-shutdown-${Date.now()}-${Math.floor(Math.random() * 1e6)}+stub-pending@nymbal.dev`,
      billingAddress: SHIPPING_ADDRESS,
      shippingAddress: SHIPPING_ADDRESS,
    },
  })
  expect(checkoutRes.ok(), `POST /api/checkout: ${await checkoutRes.text()}`).toBe(true)
  const body = (await checkoutRes.json()) as { data: { orderNumber: string } }
  expect(body.data.orderNumber).toMatch(/^(NYM|INT)-/)
  return { orderNumber: body.data.orderNumber }
}

test.describe('the admin across an API restart', () => {
  test('AC-4: SIGTERM ends the API within 3 s with the orders list open; restarted on the same port and database, the tab reconnects and shows the next order within 10 s, with no reload', async ({
    browser,
    request,
  }) => {
    test.setTimeout(180_000)
    const port = await freePort()
    const base = `http://localhost:${port}`
    const dir = mkdtempSync(join(tmpdir(), 'nymbal-e2e-shutdown-'))
    const sqlitePath = join(dir, 'nymbal.db')
    const apis: Api[] = []
    const context = await browser.newContext({ baseURL: `${base}/admin/` })
    try {
      apis.push(await startApi(port, sqlitePath))

      const page = await context.newPage()
      await watchRealtime(page)
      await signInAsAdmin(page)
      const listLoaded = page.waitForResponse(
        (r) => path(r.url()) === '/api/admin/orders' && r.request().method() === 'GET',
        { timeout: 15_000 },
      )
      await page.getByTestId('admin-nav-orders').click()
      await listLoaded
      await realtimeConnected(page)
      const connectedBefore = await connectedCount(page)

      const listUrl = page.url()
      let loads = 0
      page.on('load', () => {
        loads += 1
      })

      const exitMs = await sigtermAndTime(apis[0]!)
      expect(
        exitMs,
        `ms from SIGTERM to exit; output tail:\n${apis[0]!.output().slice(-1500)}`,
      ).toBeLessThan(EXIT_WITHIN_MS)

      apis.push(await startApi(port, sqlitePath))
      await expect
        .poll(() => connectedCount(page), {
          message: 'a second confirmed `connected` from the restarted API',
          timeout: RECONNECT_WITHIN_MS,
        })
        .toBeGreaterThan(connectedBefore)

      const { orderNumber } = await placeOrderOn(request, base)
      const row = page.getByTestId(`admin-orders-row-${orderNumber}`)
      await expect(row).toContainText(orderNumber, { timeout: ORDER_WITHIN_MS })
      expect(loads, 'page loads after the list opened').toBe(0)
      expect(page.url()).toBe(listUrl)
    } finally {
      await context.close()
      for (const api of apis) {
        if (!api.isGone()) {
          api.child.kill('SIGKILL')
          await api.exited
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
