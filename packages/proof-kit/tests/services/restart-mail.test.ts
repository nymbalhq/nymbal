import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMailSink, type MailSink } from '@nymbalhq/proof-kit/mail'
import { startTestStore, type TestStore } from '@nymbalhq/proof-kit/store'
import { createDatabase } from '../../../platform/tests/support/postgres.js'
import { openRaw, type RawReader } from '../../../platform/tests/support/raw.js'

// Acceptance tests for P1-03 AC-3: a restart sends nothing twice. A checkout and a customer registration, then two
// restarts on the same database: the buyer has exactly one order-placed email and the customer exactly one welcome
// email, the product, the order and the customer are served from the (rebuilt) document store after each restart,
// and neither the log's delivered_at values nor the email handlers' processed_events rows change. Today warm-up
// re-publishes order.placed and customer.created to the email handler on every boot (measured 1 -> 2 -> 3).
// The file refuses to load without NYMBAL_TEST_MAILPIT_URL and NYMBAL_TEST_POSTGRES_URL.

function required(name: string, example: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set: the proof-kit-services project needs it ` +
        `(pnpm gate:full starts the services with docker compose; e.g. ${name}=${example})`,
    )
  }
  return value
}

required('NYMBAL_TEST_MAILPIT_URL', 'http://localhost:18025')
const postgresServer = required(
  'NYMBAL_TEST_POSTGRES_URL',
  'postgres://postgres:nymbal@localhost:54329/nymbal',
)

type Dialect = 'sqlite' | 'postgres'

interface Database {
  target: string
  drop(): Promise<void>
}

const cases: Array<{ dialect: Dialect; fresh: () => Promise<Database> }> = [
  {
    dialect: 'sqlite',
    async fresh() {
      const dir = mkdtempSync(join(tmpdir(), 'p1-03-restart-mail-'))
      return {
        target: join(dir, 'store.sqlite'),
        async drop() {
          rmSync(dir, { recursive: true, force: true })
        },
      }
    },
  },
  {
    dialect: 'postgres',
    async fresh() {
      const db = await createDatabase(postgresServer, 'restart_mail')
      return { target: db.url, drop: () => db.drop() }
    },
  },
]

const address = {
  firstName: 'Ada',
  lastName: 'Buyer',
  addressLine1: '1 Main St',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

interface Placed {
  buyer: string
  member: string
  productId: string
  productSlug: string
  orderId: string
  orderNumber: string
  customerId: string
}

function boot(dialect: Dialect, target: string, sink: MailSink): Promise<TestStore> {
  return startTestStore(
    dialect === 'postgres'
      ? { commandStore: 'postgres', postgresUrl: target, email: sink }
      : { sqlitePath: target, email: sink },
  )
}

/** One checkout and one registration on a running store; resolves once both emails are in Mailpit. */
async function placeAndRegister(store: TestStore, sink: MailSink): Promise<Placed> {
  const { services } = store.app
  const tag = randomUUID()
  const buyer = `ac3-buyer-${tag}@proof-kit.test`
  const member = `ac3-member-${tag}@proof-kit.test`
  const product = await services.product.create({
    slug: `restart-${tag}`,
    name: 'Restart Widget',
    description: '',
    status: 'active',
    variants: [{ sku: `RESTART-${tag}`, name: 'Default', priceMinor: 1200, stock: 5, options: [] }],
  })
  const variant = product.variants[0]!
  const cart = await services.cart.getOrCreate()
  await services.cart.addItem(cart.token, {
    variantId: variant.id,
    productId: product.id,
    productName: product.name,
    variantName: variant.name,
    priceMinor: variant.priceMinor,
    imageUrl: '',
    qty: 1,
  })
  const checkout = await services.checkout.beginCheckout({
    cartToken: cart.token,
    email: buyer,
    billingAddress: address,
    shippingAddress: address,
  })
  const { customer } = await services.auth.register({ email: member, password: 'password123' })
  await sink.waitFor({ to: buyer, count: 1 }, { timeoutMs: 10_000 })
  await sink.waitFor({ to: member, count: 1 }, { timeoutMs: 10_000 })
  return {
    buyer,
    member,
    productId: product.id,
    productSlug: product.slug,
    orderId: checkout.orderId,
    orderNumber: checkout.orderNumber,
    customerId: customer.id,
  }
}

async function getData(baseUrl: string, path: string): Promise<{ status: number; id?: string }> {
  const res = await fetch(`${baseUrl}${path}`)
  const body = (await res.json()) as { data?: { id?: string } }
  return { status: res.status, ...(body.data?.id !== undefined && { id: body.data.id }) }
}

/** What the document store serves for the placed product, order and customer. */
async function served(store: TestStore, placed: Placed) {
  const profile = await store.app.platform.documentStore.get<{ customerId: string }>(
    'customer-profiles',
    placed.customerId,
  )
  return {
    product: await getData(store.baseUrl, `/api/products/${placed.productSlug}`),
    order: await getData(store.baseUrl, `/api/orders/${placed.orderNumber}`),
    customer: profile?.customerId ?? null,
  }
}

async function logState(raw: RawReader) {
  const rows = await raw.rows<{ id: string; delivered_at: unknown }>(
    'SELECT id, delivered_at FROM events ORDER BY seq',
  )
  return {
    deliveredAt: rows.map((r) => [r.id, r.delivered_at] as const),
    emailProcessed: await raw.count('processed_events', 'handler_name LIKE ?', ['email:%']),
  }
}

describe.each(cases)('AC-3: a restart sends nothing twice ($dialect)', ({ dialect, fresh }) => {
  it(`AC-3: after a checkout and a registration, two restarts leave exactly 1 order-placed and 1 welcome email, and the product, order and customer are served from the document store with the same ids after each (${dialect})`, async () => {
    const sink = createMailSink()
    const db = await fresh()
    try {
      const store = await boot(dialect, db.target, sink)
      let placed: Placed
      try {
        placed = await placeAndRegister(store, sink)
      } finally {
        await store.stop()
      }
      const expected = {
        product: { status: 200, id: placed.productId },
        order: { status: 200, id: placed.orderId },
        customer: placed.customerId,
      }

      for (const restart of [1, 2]) {
        const again = await boot(dialect, db.target, sink)
        try {
          const mails = {
            orderPlaced: (await sink.messages({ to: placed.buyer })).length,
            welcome: (await sink.messages({ to: placed.member })).length,
          }
          expect(mails, `emails after restart ${restart}`).toEqual({ orderPlaced: 1, welcome: 1 })
          expect(await served(again, placed), `document store after restart ${restart}`).toEqual(
            expected,
          )
        } finally {
          await again.stop()
        }
      }
    } finally {
      await db.drop()
    }
  }, 120_000)

  it(`AC-3: across both restarts every events row's delivered_at and the count of processed_events rows for email:% handlers are unchanged (${dialect})`, async () => {
    const sink = createMailSink()
    const db = await fresh()
    try {
      const store = await boot(dialect, db.target, sink)
      try {
        await placeAndRegister(store, sink)
      } finally {
        await store.stop()
      }

      const raw = openRaw(dialect, db.target)
      try {
        const before = await logState(raw)
        expect(before.deliveredAt.filter(([, at]) => at == null)).toEqual([])
        // order-placed and customer-created at least: the email handlers recorded what they sent.
        expect(before.emailProcessed).toBeGreaterThanOrEqual(2)

        for (const restart of [1, 2]) {
          const again = await boot(dialect, db.target, sink)
          try {
            expect(await logState(raw), `log after restart ${restart}`).toEqual(before)
          } finally {
            await again.stop()
          }
        }
      } finally {
        await raw.close()
      }
    } finally {
      await db.drop()
    }
  }, 120_000)
})
