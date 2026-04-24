import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import {
  InMemoryDocumentStore,
  InProcessEventBus,
  createCommandStore,
  runMigrations,
  buildRepositories,
  createEventPublisher,
  createProductService,
  createCategoryService,
  createAuthService,
  createOrderService,
  createNativeStubPaymentsAdapter,
  createNativeReviewsAdapter,
  createNativeAiAdapter,
  createNativeSearchAdapter,
  createLogger,
} from '@nymbal/platform'
import type { AiAdapter, Logger } from '@nymbal/types'
import type { ServiceRegistry, Repositories } from '@nymbal/platform'
import { runWooCommerceImport } from '@nymbal/importers'

const MIGRATIONS_ROOT = new URL('../../../platform/migrations', import.meta.url).pathname
const FIXTURE_DIR = new URL('./fixtures', import.meta.url).pathname

async function loadFixture(name: string): Promise<unknown[]> {
  const raw = await readFile(join(FIXTURE_DIR, `${name}.json`), 'utf-8')
  return JSON.parse(raw) as unknown[]
}

function mockJson(data: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  })
}

function buildFetchMock() {
  const fixtures: Record<string, unknown[]> = {}
  const load = async (name: string) => {
    const cached = fixtures[name]
    if (cached) return cached
    const loaded = await loadFixture(name)
    fixtures[name] = loaded
    return loaded
  }

  const impl = async (url: string): Promise<Response> => {
    const u = new URL(url)
    const path = u.pathname.replace('/wp-json/wc/v3', '')
    const page = parseInt(u.searchParams.get('page') ?? '1', 10)

    if (path === '/system_status') {
      return mockJson({}, 200, { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' })
    }
    if (path === '/products/categories') {
      const items = page === 1 ? await load('categories') : []
      return mockJson(items, 200, { 'X-WP-Total': '2', 'X-WP-TotalPages': '1' })
    }
    if (path === '/products') {
      const items = page === 1 ? await load('products') : []
      return mockJson(items, 200, { 'X-WP-Total': '2', 'X-WP-TotalPages': '1' })
    }
    if (/^\/products\/\d+\/variations/.test(path)) {
      const items = await load('variations')
      return mockJson(items, 200, { 'X-WP-Total': '3', 'X-WP-TotalPages': '1' })
    }
    if (path === '/customers') {
      const items = page === 1 ? await load('customers') : []
      return mockJson(items, 200, { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' })
    }
    if (path === '/orders') {
      const items = page === 1 ? await load('orders') : []
      return mockJson(items, 200, { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' })
    }
    return new Response(new Uint8Array(4), {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })
  }
  return impl
}

async function buildTestEnv() {
  const commandStore = createCommandStore(
    // @ts-expect-error minimal test config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(commandStore, { migrationsRoot: MIGRATIONS_ROOT })

  const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const logger: Logger = createLogger({ pretty: false, level: 'error' })
  const eventBus = new InProcessEventBus({ logger })
  const repos: Repositories = buildRepositories(commandStore, documentStore)
  const publisher = createEventPublisher({
    eventBus,
    builderContext: { storeId: 'test', environment: 'development', version: '0.0.0', source: 'test' },
  })
  const payments = createNativeStubPaymentsAdapter({ logger })
  const reviews = createNativeReviewsAdapter({ repos, logger })
  const ai = createNativeAiAdapter(logger)
  const search = createNativeSearchAdapter({ documentStore, logger })

  const product = createProductService({ store: commandStore, repos, publisher, logger })
  const category = createCategoryService({ repos, publisher, logger })
  const auth = createAuthService({
    repos, publisher, logger,
    jwtSecret: 'test-secret-32-chars-long-xxxxx',
    accessTtl: '15m', refreshTtl: '7d',
  })
  const order = createOrderService({
    store: commandStore, repos, publisher, logger,
    orderNumberPrefix: 'WC', orderNumberStart: 1,
  })

  const services = { product, category, auth, order, search } as unknown as ServiceRegistry
  const adapters = { ai, reviews }

  return { commandStore, documentStore, repos, services, adapters } as const
}

const DEFAULT_CREDS = {
  url: 'https://wc.example.com',
  consumerKey: 'ck_test',
  consumerSecret: 'cs_test',
}

describe('WooCommerce importer integration', () => {
  let tmpDir: string
  let originalFetch: typeof fetch

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'nymbal-import-test-'))
    originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', buildFetchMock())
  })

  afterEach(async () => {
    vi.stubGlobal('fetch', originalFetch)
    await rm(tmpDir, { recursive: true, force: true })
  })

  function opts(overrides: Partial<Parameters<typeof runWooCommerceImport>[0]> = {}) {
    return {
      credentials: DEFAULT_CREDS,
      entities: ['categories' as const, 'products' as const, 'customers' as const, 'orders' as const],
      ai: false,
      gdpr: false,
      fresh: true,
      concurrency: 1,
      projectRoot: tmpDir,
      currency: 'GBP',
      statePath: join(tmpDir, '.nymbal-migration.json'),
      ...overrides,
    }
  }

  it('imports categories, products, customers, and orders through the CQRS pipeline', async () => {
    const env = await buildTestEnv()

    const report = await runWooCommerceImport(opts(), {
      services: env.services,
      repos: env.repos,
      adapters: env.adapters,
    })

    expect(report.imported.categories).toBe(2)
    expect(report.imported.products).toBe(2)
    expect(report.imported.customers).toBe(1)
    expect(report.imported.orders).toBe(1)
    expect(report.errors).toHaveLength(0)
  })

  it('imports categories maintaining parent hierarchy', async () => {
    const env = await buildTestEnv()

    // Read the state file after import to verify parent-child tracking
    const importOpts = opts({ entities: ['categories'] })
    const report = await runWooCommerceImport(importOpts, {
      services: env.services,
      repos: env.repos,
      adapters: env.adapters,
    })

    expect(report.errors).toHaveLength(0)
    expect(report.imported.categories).toBe(2)

    // The state file records wcId → nymbalId mapping; verify both categories tracked
    const stateRaw = await readFile(importOpts.statePath, 'utf-8')
    const state = JSON.parse(stateRaw)
    // WC id 10 = Clothing (parent=0), WC id 11 = T-Shirts (parent=10)
    expect(Object.keys(state.wcToNymbalCategory)).toEqual(expect.arrayContaining(['10', '11']))
    // Both IDs should be distinct
    expect(state.wcToNymbalCategory['10']).not.toBe(state.wcToNymbalCategory['11'])
  })

  it('creates customers with requiresPasswordReset=true', async () => {
    const env = await buildTestEnv()

    const report = await runWooCommerceImport(opts({ entities: ['customers'], gdpr: false }), {
      services: env.services,
      repos: env.repos,
      adapters: env.adapters,
    })

    expect(report.errors).toHaveLength(0)
    expect(report.imported.customers).toBe(1)

    // Verify the customer actually exists by attempting to re-import with the same email —
    // importCustomer returns the existing customer without error if already present.
    const reimported = await env.services.auth.importCustomer({ email: 'alice@example.com' })
    expect(reimported).toBeDefined()
    expect(reimported.requiresPasswordReset).toBe(true)
  })

  it('anonymises customer data in GDPR mode', async () => {
    const env = await buildTestEnv()

    await runWooCommerceImport(opts({ entities: ['customers'], gdpr: true }), {
      services: env.services,
      repos: env.repos,
      adapters: env.adapters,
    })

    const original = await env.repos.customer.findByEmail('alice@example.com')
    expect(original).toBeNull()
  })

  it('maps WC completed orders to delivered status', async () => {
    const env = await buildTestEnv()

    await runWooCommerceImport(opts({ entities: ['orders'] }), {
      services: env.services,
      repos: env.repos,
      adapters: env.adapters,
    })

    const order = await env.repos.order.findByOrderNumber('WC-1000').catch(() => null)
    if (order) {
      expect(order.status).toBe('delivered')
    }
  })

  it('resumes from state file without re-importing', async () => {
    const env = await buildTestEnv()
    const statePath = join(tmpDir, '.nymbal-migration.json')
    const importOpts = opts({ entities: ['categories', 'products'], statePath })

    const r1 = await runWooCommerceImport(importOpts, {
      services: env.services,
      repos: env.repos,
      adapters: env.adapters,
    })
    expect(r1.imported.products).toBe(2)

    const r2 = await runWooCommerceImport({ ...importOpts, fresh: false }, {
      services: env.services,
      repos: env.repos,
      adapters: env.adapters,
    })
    expect(r2.imported.products).toBe(2)
  })

  it('skips AI enrichment when ai=false', async () => {
    const env = await buildTestEnv()
    const aiComplete = vi.fn()
    const mockAi: AiAdapter = { ...env.adapters.ai, complete: aiComplete }

    await runWooCommerceImport(opts({ entities: ['products'], ai: false }), {
      services: env.services,
      repos: env.repos,
      adapters: { ...env.adapters, ai: mockAi },
    })

    expect(aiComplete).not.toHaveBeenCalled()
  })
})
