import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test'
import { expect, test } from '../../support/fixtures'
import { API_URL, csrf } from '../../support/csrf'
import { adminToken as sharedAdminToken } from '../../support/checkout'
import { ADMIN_EMAIL, ADMIN_PASSWORD, signInAsAdmin } from '../../support/admin'
import { startAiStandIn, type AiStandIn, type ScriptReply } from '../../../support/ai-stand-in'
import { goldenScript } from '../../../support/assistant-golden'

// The merchant's assistant in the admin's Cmd-K palette (the Ask tab), on an API of the journey's own started from
// tests/e2e/fixtures/assistant (the demo store, `ai` on Anthropic, its baseUrl a provider stand-in in `script` mode this
// file starts and drives: tests/support/assistant-golden.ts answers the golden questions, a word at a time), as
// admin/settings.spec.ts runs one. The `ai: none` half of AC-22 runs on the shared store.
// - AC-19: an answer streams in parts with one step per tool, its one EventSource is closed after done and its stream
//   URL requested once.
// - AC-20: a write is a pending card, the store unchanged until a double-clicked Approve applies it once.
// - AC-21: rapid Enters send one turn and make one proposal; rapid clicks on Reject decide once.
// - AC-13 (cards that show the change): the price and stock questions show pending cards naming what they act on and
//   the value now beside the value proposed, in the panel and in the inbox, and change nothing.
// - AC-22: Esc mid-answer stops the turn (the provider request closed, nothing after it) and the answer reads Stopped;
//   on a store with no provider, Ask points to Settings and proposes nothing.

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const CLI_BIN = join(REPO_ROOT, 'packages', 'cli', 'bin', 'nymbal.mjs')
const ADMIN_DIST = join(REPO_ROOT, 'apps', 'admin', 'dist')
const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/assistant', import.meta.url))

const READY_WITHIN_MS = 30_000
const EXIT_WITHIN_MS = 10_000
const ASSISTANT = 'nymbal-assistant'
const STREAM = /^\/api\/admin\/assistant\/turns\/[^/]+\/stream$/
const TURNS = '/api/admin/assistant/turns'
const BOOKS = 'How many products are in the Books category?'
const RAISE = 'Raise the price of the Stoneware Mug to 21.00.'
const SOCKS = 'Add 40 Runner Socks to stock.'
const WEATHER = 'What is the weather in Paris?'
const LONG = 'Tell me everything about the Stoneware Mug, slowly.'
/** A long answer, a word at a time, then a write: what a turn the merchant stopped would have gone on to propose. */
const LONG_ANSWER = Array.from({ length: 40 }, (_, i) => `word${i + 1}`).join(' ')

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
}

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
  const deadline = Date.now() + READY_WITHIN_MS
  while (Date.now() < deadline && !gone) {
    const up = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(1000) })
      .then((r) => r.ok)
      .catch(() => false)
    if (up) return { child, exited, isGone: () => gone }
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!gone) child.kill('SIGKILL')
  throw new Error(
    `the assistant fixture API did not answer /health on :${port}. Output:\n${out.slice(-2000)}`,
  )
}

async function stopApi(api: Api): Promise<void> {
  if (api.isGone()) return
  api.child.kill('SIGTERM')
  const timer = setTimeout(() => api.child.kill('SIGKILL'), EXIT_WITHIN_MS)
  await api.exited
  clearTimeout(timer)
}

interface Store {
  standIn: AiStandIn
  base: string
  close(): Promise<void>
}

/** The golden questions a word every 250 ms; LONG a word every 300 ms and then a write. */
function script(): AiStandIn['script'] {
  const golden = goldenScript({ currency: 'GBP', delayMs: 250 })
  return (view) => {
    const last = view.turns.filter((t) => t.role === 'user').at(-1)?.content ?? ''
    if (last !== LONG) return golden(view)
    const reply: ScriptReply = {
      text: LONG_ANSWER,
      toolCalls: [
        { name: 'admin_products_update', args: { id: 'ceramic-mug', name: 'Stopped Mug' } },
      ],
      delayMs: 300,
    }
    return view.turns.at(-1)?.role === 'tool' ? { text: 'Done.' } : reply
  }
}

async function startStore(): Promise<Store> {
  const standIn = await startAiStandIn('anthropic', 'script', script())
  const port = await freePort()
  const dir = mkdtempSync(join(tmpdir(), 'nymbal-e2e-assistant-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NYMBAL_SQLITE_PATH: join(dir, 'nymbal.db'),
    NYMBAL_ADMIN_DIST: ADMIN_DIST,
    NYMBAL_SECRETS_KEY: randomBytes(32).toString('base64'),
    NYMBAL_E2E_AI_BASE_URL: standIn.url,
    ANTHROPIC_API_KEY: `sk-ant-e2e-${randomBytes(18).toString('base64url')}`,
  }
  let api: Api | undefined
  const close = async () => {
    if (api !== undefined) await stopApi(api)
    await standIn.close()
    rmSync(dir, { recursive: true, force: true })
  }
  try {
    api = await startApi(port, env)
  } catch (error) {
    await close()
    throw error
  }
  return { standIn, base: `http://localhost:${port}`, close }
}

// ─── The API, as a journey reads it ─────────────────────────────────────────────────────────────────────────────────

async function tokenFor(request: APIRequestContext, base: string): Promise<string> {
  const res = await request.post(`${base}/api/auth/login`, {
    headers: await csrf(request, base),
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  })
  expect(res.ok(), `POST /api/auth/login: ${await res.text()}`).toBe(true)
  return ((await res.json()) as { data: { accessToken: string } }).data.accessToken
}

async function getData<T>(
  request: APIRequestContext,
  base: string,
  token: string,
  path: string,
): Promise<T> {
  const res = await request.get(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })
  expect(res.status(), `GET ${path}: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: T }).data
}

interface Proposal {
  id: string
  tool: string
  command: string
  status: string
  correlationId: string
  proposer: { userId: string | null; agent: { name: string } }
}

const proposals = (request: APIRequestContext, base: string, token: string) =>
  getData<{ items: Proposal[]; pending: number }>(
    request,
    base,
    token,
    '/api/admin/proposals?status=all&limit=200',
  )

const mugPrice = async (request: APIRequestContext, base: string, token: string): Promise<number> =>
  (
    await getData<{ variants: Array<{ priceMinor: number }> }>(
      request,
      base,
      token,
      '/api/admin/products/ceramic-mug',
    )
  ).variants[0]!.priceMinor

/** Minor units as the admin shows them (`formatMoney`, en-GB). */
const pounds = (minor: number): string =>
  new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: 2,
  }).format(minor / 100)

/** An element's text with its whitespace collapsed. */
const textOf = async (locator: ReturnType<Page['getByTestId']>): Promise<string[]> =>
  (await locator.allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim())

// ─── The page ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every EventSource the page opens, kept in `window.__assistantSources`. */
async function watchEventSources(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.EventSource
    const w = window as unknown as { __assistantSources: EventSource[] }
    w.__assistantSources = []
    class Watched extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init)
        w.__assistantSources.push(this)
      }
    }
    window.EventSource = Watched
  })
}

/** The readyState of each EventSource the page opened on an assistant stream (2 is CLOSED). */
const assistantSources = (page: Page): Promise<number[]> =>
  page.evaluate(() =>
    (window as unknown as { __assistantSources: EventSource[] }).__assistantSources
      .filter((s) => new URL(s.url).pathname.startsWith('/api/admin/assistant/turns/'))
      .map((s) => s.readyState),
  )

/** The requests the page sends that `matches` admits, by pathname. */
function watchRequests(page: Page, matches: (method: string, path: string) => boolean): string[] {
  const seen: string[] = []
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname
    if (matches(r.method(), path)) seen.push(path)
  })
  return seen
}

async function openAsk(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('admin-search-tab-ask').click({ timeout: 15_000 })
  await expect(page.getByTestId('admin-assistant-input')).toBeEditable()
}

async function askQuestion(page: Page, question: string): Promise<void> {
  await page.getByTestId('admin-assistant-input').fill(question)
  await page.getByTestId('admin-assistant-input').press('Enter')
}

const lastAnswer = (page: Page) => page.getByTestId('admin-assistant-answer').last()

/** The one proposal card the panel shows that `known` did not hold, and its id. */
async function newCard(page: Page, known: Set<string>): Promise<string> {
  const cards = page.locator(
    '[data-testid^="admin-assistant-proposal-"]:not([data-testid^="admin-assistant-proposal-status-"])',
  )
  let id = ''
  await expect
    .poll(
      async () => {
        const ids = (
          await cards.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''))
        )
          .map((testid) => testid.slice('admin-assistant-proposal-'.length))
          .filter((one) => !known.has(one))
        id = ids[0] ?? ''
        return ids.length
      },
      { timeout: 15_000 },
    )
    .toBe(1)
  return id
}

async function signedInContext(
  browser: Browser,
  base: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: `${base}/admin/` })
  const page = await context.newPage()
  await watchEventSources(page)
  await signInAsAdmin(page)
  return { context, page }
}

test.describe('the assistant in the admin palette', () => {
  // One store for the four, in order: AC-21 counts the proposals AC-20 left.
  test.describe.configure({ mode: 'default' })
  let store: Store
  let token = ''
  let context: BrowserContext | undefined

  test.beforeAll(async ({ request }) => {
    test.setTimeout(90_000)
    store = await startStore()
    token = await tokenFor(request, store.base)
  })

  test.afterEach(async () => {
    await context?.close()
    context = undefined
  })

  test.afterAll(async () => {
    await store?.close()
  })

  test('AC-19: assistant.answer-streams: the Books question shows one step for the product read and an answer that reads streaming with part of its text before done with all of it, holding the count GET /api/products?category=books gives; one POST per question, and each EventSource is closed after done with its stream URL requested once', async ({
    browser,
    request,
  }) => {
    test.setTimeout(90_000)
    const books = await request.get(`${store.base}/api/products?category=books&limit=100`)
    const count = ((await books.json()) as { data: { items: unknown[] } }).data.items.length
    const signed = await signedInContext(browser, store.base)
    context = signed.context
    const page = signed.page
    const posts = watchRequests(page, (method, path) => method === 'POST' && path === TURNS)
    const streams = watchRequests(page, (method, path) => method === 'GET' && STREAM.test(path))
    await openAsk(page)

    await askQuestion(page, BOOKS)
    const answer = lastAnswer(page)
    await expect(answer).toHaveAttribute('data-state', 'streaming', { timeout: 15_000 })
    await expect(answer).toHaveText(/\S/)
    // The text so far and the state it was shown in, read in one step.
    const seen = await answer.evaluate((el) => ({
      text: (el.textContent ?? '').trim(),
      state: el.getAttribute('data-state'),
    }))
    await expect(answer).toHaveAttribute('data-state', 'done', { timeout: 15_000 })
    const whole = ((await answer.textContent()) ?? '').trim()
    const steps = page.getByTestId('admin-assistant-step')

    expect(seen.state).toBe('streaming')
    expect(seen.text.length).toBeLessThan(whole.length)
    expect(whole.startsWith(seen.text)).toBe(true)
    expect(whole).toContain(String(count))
    await expect(steps).toHaveCount(1)
    await expect(steps.first()).toHaveAttribute('data-tool', 'products_list')
    await expect(steps.first()).toHaveAttribute('data-ok', 'true')
    expect(await assistantSources(page)).toEqual([2])

    // A second question takes longer than a reconnect would: the first turn's stream is still requested once after it.
    await askQuestion(page, WEATHER)
    await expect(lastAnswer(page)).toHaveAttribute('data-state', 'done', { timeout: 15_000 })
    expect(posts.length).toBe(2)
    expect(streams.length).toBe(posts.length)
    expect(new Set(streams).size).toBe(streams.length)
    expect(await assistantSources(page)).toEqual([2, 2])
  })

  test('AC-13: assistant.card-shows-change and proposals.card-shows-change: the price question shows a pending card naming the Stoneware Mug and its price now beside 21.00, the stock question one naming the Runner Socks variant and its stock now beside it plus 40, the inbox rows of both show the same, and neither product changes', async ({
    browser,
    request,
  }) => {
    test.setTimeout(120_000)
    const mug = await getData<{
      name: string
      variants: Array<{ id: string; name: string; priceMinor: number }>
    }>(request, store.base, token, '/api/admin/products/ceramic-mug')
    const stockOf = async (variantId: string): Promise<number> =>
      (
        await getData<Array<{ variantId: string; stock: number }>>(
          request,
          store.base,
          token,
          `/api/admin/inventory?q=${encodeURIComponent('Runner Socks')}`,
        )
      ).find((r) => r.variantId === variantId)!.stock
    const known = new Set((await proposals(request, store.base, token)).items.map((p) => p.id))
    const signed = await signedInContext(browser, store.base)
    context = signed.context
    const page = signed.page
    await openAsk(page)

    await askQuestion(page, RAISE)
    const priceId = await newCard(page, known)
    await expect(lastAnswer(page)).toHaveAttribute('data-state', 'done', { timeout: 15_000 })
    known.add(priceId)
    await askQuestion(page, SOCKS)
    const stockId = await newCard(page, known)
    await expect(lastAnswer(page)).toHaveAttribute('data-state', 'done', { timeout: 15_000 })

    const all = await proposals(request, store.base, token)
    const stockArgs = (
      await getData<{ args: { variantId: string } }>(
        request,
        store.base,
        token,
        `/api/admin/proposals/${stockId}`,
      )
    ).args
    const socks = (
      await getData<Array<{ variantId: string; productName: string; sku: string; stock: number }>>(
        request,
        store.base,
        token,
        `/api/admin/inventory?q=${encodeURIComponent('Runner Socks')}`,
      )
    ).find((r) => r.variantId === stockArgs.variantId)!
    const priceLine = `Price of ${mug.variants[0]!.name}: ${pounds(mug.variants[0]!.priceMinor)} → ${pounds(2100)}`
    const stockLine = `Stock: ${socks.stock} → ${socks.stock + 40}`

    expect(
      all.items.filter((p) => p.id === priceId || p.id === stockId).map((p) => p.status),
    ).toEqual(['pending', 'pending'])
    await expect(page.getByTestId(`admin-assistant-target-${priceId}`)).toContainText(mug.name)
    expect(await textOf(page.getByTestId(`admin-assistant-change-${priceId}`))).toEqual([priceLine])
    await expect(page.getByTestId(`admin-assistant-target-${stockId}`)).toContainText(socks.sku)
    expect(await textOf(page.getByTestId(`admin-assistant-change-${stockId}`))).toEqual([stockLine])

    const inbox = await context.newPage()
    await inbox.goto('inbox')
    await inbox.getByTestId('admin-inbox-tab-pending').click()
    await expect(inbox.getByTestId(`admin-inbox-target-${priceId}`)).toContainText(mug.name, {
      timeout: 15_000,
    })
    expect(await textOf(inbox.getByTestId(`admin-inbox-change-${priceId}`))).toEqual([priceLine])
    await expect(inbox.getByTestId(`admin-inbox-target-${stockId}`)).toContainText(socks.sku)
    expect(await textOf(inbox.getByTestId(`admin-inbox-change-${stockId}`))).toEqual([stockLine])
    await inbox.close()

    expect(await mugPrice(request, store.base, token)).toBe(mug.variants[0]!.priceMinor)
    expect(await stockOf(socks.variantId)).toBe(socks.stock)
  })

  test('AC-20: assistant.write-is-proposal and approve-applies-once: the price question shows a pending admin.products.update card with its arguments while the product is unchanged and the inbox lists it pending; a double-clicked Approve applies it once: price 2100, one product.update entry by the admin under the proposal’s correlation id, the card reads Applied and the inbox’s decided tab shows it applied by nymbal-assistant', async ({
    browser,
    request,
  }) => {
    test.setTimeout(120_000)
    const priceBefore = await mugPrice(request, store.base, token)
    const known = new Set((await proposals(request, store.base, token)).items.map((p) => p.id))
    const me = (await getData<{ userId: string }>(request, store.base, token, '/api/admin/me'))
      .userId
    const signed = await signedInContext(browser, store.base)
    context = signed.context
    const page = signed.page
    await openAsk(page)

    await askQuestion(page, RAISE)
    const id = await newCard(page, known)
    const card = page.getByTestId(`admin-assistant-proposal-${id}`)
    await expect(card).toContainText(/product\.update|admin[._]products[._]update/)
    await expect(card).toContainText('2100')
    await expect(page.getByTestId(`admin-assistant-proposal-status-${id}`)).toHaveText(/pending/i)
    await expect(lastAnswer(page)).toHaveAttribute('data-state', 'done', { timeout: 15_000 })
    expect(await mugPrice(request, store.base, token)).toBe(priceBefore)

    const inbox = await context.newPage()
    await inbox.goto('inbox')
    await inbox.getByTestId('admin-inbox-tab-pending').click()
    await expect(inbox.getByTestId(`admin-inbox-row-${id}`)).toContainText(ASSISTANT, {
      timeout: 15_000,
    })
    await inbox.close()

    const approves: string[] = []
    page.on('request', (r) => {
      if (
        r.method() === 'POST' &&
        new URL(r.url()).pathname === `/api/admin/proposals/${id}/approve`
      ) {
        approves.push(r.url())
      }
    })
    await page.getByTestId(`admin-assistant-approve-${id}`).dblclick()
    await expect(page.getByTestId(`admin-assistant-proposal-status-${id}`)).toHaveText(/applied/i, {
      timeout: 15_000,
    })

    const read = (await proposals(request, store.base, token)).items.find((p) => p.id === id)!
    const entries = await getData<
      Array<{ command: string; outcome: string; actor: { id: string } }>
    >(
      request,
      store.base,
      token,
      `/api/admin/activity?correlation=${encodeURIComponent(read.correlationId)}&command=product.update`,
    )
    expect(read.status).toBe('applied')
    expect(read.proposer.agent.name).toBe(ASSISTANT)
    expect(await mugPrice(request, store.base, token)).toBe(2100)
    expect(
      entries.filter((e) => e.outcome === 'applied').map((e) => e.actor.id),
      `${approves.length} approve POSTs sent`,
    ).toEqual([me])

    await page.goto('inbox')
    await page.getByTestId('admin-inbox-tab-decided').click()
    await expect(page.getByTestId(`admin-inbox-status-${id}`)).toHaveText(/applied/i, {
      timeout: 15_000,
    })
    await expect(page.getByTestId(`admin-inbox-row-${id}`)).toContainText(ASSISTANT)
  })

  test('AC-21: standing.submit-once-admin: five rapid Enters on the Ask input send one turn POST and leave one pending proposal; three rapid clicks on the card’s Reject make one decision', async ({
    browser,
    request,
  }) => {
    test.setTimeout(120_000)
    const before = await proposals(request, store.base, token)
    const known = new Set(before.items.map((p) => p.id))
    const signed = await signedInContext(browser, store.base)
    context = signed.context
    const page = signed.page
    const posts = watchRequests(page, (method, path) => method === 'POST' && path === TURNS)
    const rejects = watchRequests(
      page,
      (method, path) => method === 'POST' && /^\/api\/admin\/proposals\/[^/]+\/reject$/.test(path),
    )
    await openAsk(page)

    await page.getByTestId('admin-assistant-input').fill(SOCKS)
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('Enter')
    const id = await newCard(page, known)
    await expect(lastAnswer(page)).toHaveAttribute('data-state', 'done', { timeout: 15_000 })
    const afterAsk = await proposals(request, store.base, token)

    expect(posts.length).toBe(1)
    expect(afterAsk.items.filter((p) => !known.has(p.id)).map((p) => [p.id, p.status])).toEqual([
      [id, 'pending'],
    ])
    expect(afterAsk.pending).toBe(before.pending + 1)

    await page.getByTestId(`admin-assistant-reject-${id}`).click({ clickCount: 3 })
    await expect(page.getByTestId(`admin-assistant-proposal-status-${id}`)).toHaveText(
      /rejected/i,
      {
        timeout: 15_000,
      },
    )
    const read = (await proposals(request, store.base, token)).items.find((p) => p.id === id)!
    const decisions = await getData<Array<{ outcome: string }>>(
      request,
      store.base,
      token,
      `/api/admin/activity?command=proposal.reject&subject=${encodeURIComponent(id)}`,
    )
    expect(read.status).toBe('rejected')
    expect(
      decisions.filter((e) => e.outcome === 'applied').length,
      `${rejects.length} reject POSTs sent`,
    ).toBe(1)
    expect((await proposals(request, store.base, token)).pending).toBe(before.pending)
  })

  test('AC-22: assistant.stop: Esc while an answer streams closes the panel, the provider sees that request closed and no further request, no proposal follows, and reopening Ask shows the answer as Stopped', async ({
    browser,
    request,
  }) => {
    test.setTimeout(90_000)
    const known = new Set((await proposals(request, store.base, token)).items.map((p) => p.id))
    const signed = await signedInContext(browser, store.base)
    context = signed.context
    const page = signed.page
    await openAsk(page)
    const sent = store.standIn.requests.length

    await askQuestion(page, LONG)
    const answer = lastAnswer(page)
    await expect(answer).toHaveAttribute('data-state', 'streaming', { timeout: 15_000 })
    await expect(answer).toContainText('word2')
    await page.keyboard.press('Escape')

    await expect(page.getByTestId('admin-assistant-input')).toBeHidden()
    await expect
      .poll(() => store.standIn.requests.slice(sent).map((r) => r.closedEarly), { timeout: 10_000 })
      .toEqual([true])
    expect(
      (await proposals(request, store.base, token)).items.filter((p) => !known.has(p.id)),
    ).toEqual([])
    await openAsk(page)
    await expect(lastAnswer(page)).toHaveAttribute('data-state', 'stopped')
    await expect(lastAnswer(page)).toContainText(/stopped/i)
    expect(await assistantSources(page)).toEqual([2])
    expect(store.standIn.requests.length).toBe(sent + 1)
  })
})

test.describe('the assistant on a store with no AI provider', () => {
  test('AC-22: assistant.no-provider: on the shared store (ai none) asking shows admin-assistant-unavailable linking to /admin/settings, sends nothing to a stream, and leaves the pending proposal count as it was', async ({
    page,
    request,
  }) => {
    const token = await sharedAdminToken(request)
    const pending = async () =>
      (
        await getData<{ pending: number }>(
          request,
          API_URL,
          token,
          '/api/admin/proposals?status=pending',
        )
      ).pending
    const before = await pending()
    const streams = watchRequests(page, (method, path) => method === 'GET' && STREAM.test(path))
    await signInAsAdmin(page)
    await openAsk(page)

    await askQuestion(page, RAISE)

    const unavailable = page.getByTestId('admin-assistant-unavailable')
    await expect(unavailable).toBeVisible({ timeout: 15_000 })
    await expect(unavailable.getByRole('link')).toHaveAttribute('href', /\/admin\/settings$/)
    expect(streams).toEqual([])
    expect(await pending()).toBe(before)
  })
})
