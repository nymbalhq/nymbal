import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { csrf } from '../../support/csrf'
import { ADMIN_EMAIL, ADMIN_PASSWORD, signInAsAdmin } from '../../support/admin'

// AC-8: the admin's Settings page, on an API of the journey's own started from tests/e2e/fixtures/settings (ai on
// Anthropic, its declared baseUrl a stub provider this file starts, NYMBAL_SECRETS_KEY set), on a free port and a
// database of its own, as admin/api-restart.spec.ts runs one.
// - write-only: `admin-nav-settings` shows the AI slot's apiKey `Not set`; saving a value reads `Set`, shows the
//   restart note and empties the input, and neither the page's HTML nor any network response body ever carries the
//   value; the config-set baseUrl reads "Set by environment" and offers no input.
// - applies after restart: after the API restarts on the same database, GET /api/admin/settings reports the apiKey's
//   source as `settings`, and product enhance reaches the stub provider carrying that key.

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const CLI_BIN = join(REPO_ROOT, 'packages', 'cli', 'bin', 'nymbal.mjs')
const ADMIN_DIST = join(REPO_ROOT, 'apps', 'admin', 'dist')
const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/settings', import.meta.url))

const READY_WITHIN_MS = 30_000
const EXIT_WITHIN_MS = 10_000
const STUB_TEXT = 'A stub suggestion from the E2E provider'

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

interface AiStub {
  url: string
  /** The `x-api-key` of every call, in order. */
  keys: Array<string | undefined>
  close(): Promise<void>
}

/** A stand-in for Anthropic's Messages API: every call's key recorded, every message answered with one text block. */
async function startAiStub(): Promise<AiStub> {
  const keys: Array<string | undefined> = []
  const server: Server = createHttpServer((req, res) => {
    req.resume()
    req.on('end', () => {
      keys.push(req.headers['x-api-key'] as string | undefined)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: `msg_${randomUUID()}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: STUB_TEXT }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}`,
    keys,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

interface Api {
  child: ChildProcess
  exited: Promise<number | null>
  isGone: () => boolean
  output: () => string
}

/** `nymbal dev --api-only --port <port>` from the settings fixture on `sqlitePath`, answering `/health` first. */
async function startApi(port: number, env: NodeJS.ProcessEnv): Promise<Api> {
  const child = spawn(process.execPath, [CLI_BIN, 'dev', '--api-only', '--port', String(port)], {
    cwd: FIXTURE_DIR,
    env,
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
    `the settings fixture API did not answer GET /health on :${port} within ${READY_WITHIN_MS} ms` +
      ` (${gone ? 'it exited' : 'still running'}). Output:\n${out.slice(-2000)}`,
  )
}

async function stopApi(api: Api): Promise<void> {
  if (api.isGone()) return
  api.child.kill('SIGTERM')
  const timer = setTimeout(() => api.child.kill('SIGKILL'), EXIT_WITHIN_MS)
  await api.exited
  clearTimeout(timer)
}

interface FieldView {
  path: string
  state?: string
  source?: string | null
}

/** The `{ slot, path }` field of a GET /api/admin/settings body, wherever the slot entries sit in it. */
function settingsField(body: unknown, slot: string, path: string): FieldView | undefined {
  const visit = (node: unknown, hint: string | undefined): FieldView | undefined => {
    if (typeof node !== 'object' || node === null) return undefined
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item, hint)
        if (found) return found
      }
      return undefined
    }
    const record = node as Record<string, unknown>
    const at = typeof record['slot'] === 'string' ? record['slot'] : hint
    if (Array.isArray(record['fields'])) {
      return at === slot
        ? (record['fields'] as FieldView[]).find((f) => f?.path === path)
        : undefined
    }
    for (const [key, value] of Object.entries(record)) {
      const found = visit(value, key)
      if (found) return found
    }
    return undefined
  }
  return visit(body, undefined)
}

/** An admin bearer token from POST /api/auth/login on `base`. */
async function adminToken(request: APIRequestContext, base: string): Promise<string> {
  const res = await request.post(`${base}/api/auth/login`, {
    headers: await csrf(request, base),
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  })
  expect(res.ok(), `POST /api/auth/login: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: { accessToken: string } }).data.accessToken
}

interface Store {
  stub: AiStub
  port: number
  base: string
  env: NodeJS.ProcessEnv
  apis: Api[]
  /** Stops every API it started, the stub, and removes its database. */
  close(): Promise<void>
}

/** The fixture API on a free port and a database of its own, its AI baseUrl a fresh stub, NYMBAL_SECRETS_KEY set. */
async function startStore(): Promise<Store> {
  const stub = await startAiStub()
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'nymbal-e2e-settings-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NYMBAL_SQLITE_PATH: join(dir, 'nymbal.db'),
    NYMBAL_ADMIN_DIST: ADMIN_DIST,
    NYMBAL_SECRETS_KEY: randomBytes(32).toString('base64'),
    NYMBAL_E2E_AI_BASE_URL: stub.url,
  }
  delete env['ANTHROPIC_API_KEY']
  const apis: Api[] = []
  const close = async () => {
    for (const api of apis) await stopApi(api)
    await stub.close()
    rmSync(dir, { recursive: true, force: true })
  }
  try {
    apis.push(await startApi(port, env))
  } catch (error) {
    await close()
    throw error
  }
  return { stub, port, base: `http://localhost:${port}`, env, apis, close }
}

/** Signs in, opens Settings from the nav, and saves `value` as the AI slot's apiKey, waiting for the PUT's answer. */
async function saveApiKeyInPage(page: Page, value: string): Promise<number> {
  await signInAsAdmin(page)
  await page.getByTestId('admin-nav-settings').click({ timeout: 15_000 })
  await page.getByTestId('settings-input-ai-apiKey').fill(value)
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === 'PUT' &&
      new URL(r.url()).pathname.startsWith('/api/admin/settings/'),
  )
  await page.getByTestId('settings-save-ai-apiKey').click()
  return (await saved).status()
}

test.describe('the admin Settings page', () => {
  let store: Store | undefined
  let context: BrowserContext | undefined

  test.afterEach(async () => {
    await context?.close()
    context = undefined
    await store?.close()
    store = undefined
  })

  test('AC-8: settings.write-only: the AI apiKey reads Not set, then Set with the restart note and an empty input, and neither the page nor any response body carries the value; the config-set baseUrl is "Set by environment" with no input', async ({
    browser,
  }) => {
    test.setTimeout(120_000)
    const value = `sk-ant-settings-${randomBytes(24).toString('base64url')}`
    store = await startStore()
    context = await browser.newContext({ baseURL: `${store.base}/admin/` })
    const page: Page = await context.newPage()
    const bodies: Array<{ url: string; text: string }> = []
    const reading: Array<Promise<void>> = []
    page.on('response', (response) => {
      // The admin's event stream stays open on every page, so its body never ends; AC-4 checks its envelope.
      if ((response.headers()['content-type'] ?? '').includes('text/event-stream')) return
      reading.push(
        response
          .text()
          .then((text) => void bodies.push({ url: response.url(), text }))
          .catch(() => undefined),
      )
    })

    await signInAsAdmin(page)
    await page.getByTestId('admin-nav-settings').click({ timeout: 15_000 })
    const state = page.getByTestId('settings-state-ai-apiKey')
    await expect(state).toHaveText('Not set')

    const input = page.getByTestId('settings-input-ai-apiKey')
    await input.fill(value)
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === 'PUT' &&
        new URL(r.url()).pathname.startsWith('/api/admin/settings/'),
    )
    await page.getByTestId('settings-save-ai-apiKey').click()
    expect((await saved).status()).toBe(200)

    await expect(state).toHaveText('Set')
    await expect(page.getByTestId('settings-restart-note')).toContainText(
      'Saved. Restart the store to apply.',
    )
    await expect(input).toHaveValue('')

    const baseUrlField = page.getByTestId('settings-field-ai-baseUrl')
    await expect(baseUrlField).toContainText('Set by environment')
    await expect(page.getByTestId('settings-input-ai-baseUrl')).toHaveCount(0)

    await Promise.all(reading)
    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies.filter((b) => b.text.includes(value)).map((b) => b.url)).toEqual([])
    expect(await page.content()).not.toContain(value)
  })

  test('AC-8: settings.applies-after-restart: a key saved in the page is, after the API restarts, listed with source settings, and product enhance reaches the stub provider with it', async ({
    browser,
    request,
  }) => {
    test.setTimeout(150_000)
    const value = `sk-ant-settings-${randomBytes(24).toString('base64url')}`
    store = await startStore()
    context = await browser.newContext({ baseURL: `${store.base}/admin/` })
    expect(await saveApiKeyInPage(await context.newPage(), value)).toBe(200)

    await stopApi(store.apis[store.apis.length - 1]!)
    store.apis.push(await startApi(store.port, store.env))
    const token = await adminToken(request, store.base)
    const auth = { authorization: `Bearer ${token}` }

    const listing = await request.get(`${store.base}/api/admin/settings`, { headers: auth })
    expect(listing.status()).toBe(200)
    const listed = await listing.text()
    expect(listed).not.toContain(value)
    expect(settingsField(JSON.parse(listed), 'ai', 'apiKey')?.source).toBe('settings')

    const before = store.stub.keys.length
    const enhanced = await request.post(
      `${store.base}/api/admin/products/${randomUUID()}/enhance`,
      {
        headers: { ...auth, ...(await csrf(request, store.base)) },
        data: { field: 'description', context: { name: 'Settings Widget' } },
      },
    )
    expect(enhanced.status(), await enhanced.text()).toBe(200)
    expect(store.stub.keys.length).toBeGreaterThan(before)
    expect(store.stub.keys.slice(before)).toEqual([value])
    expect(((await enhanced.json()) as { data: { suggestion: string } }).data.suggestion).toBe(
      STUB_TEXT,
    )
  })
})
