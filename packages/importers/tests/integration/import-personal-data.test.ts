import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatReport,
  journalPathFor,
  loadState,
  planWooCommerceImport,
  type ImportPlan,
} from '@nymbalhq/importers'
import type { Order } from '@nymbalhq/types'
import { documentModelsOf } from '../../../platform/tests/support/read-model-shapes.js'
import { createTestMailAdapter } from '../../../platform/tests/support/test-mail.js'
import { tableSnapshot } from '../../../../tests/support/store-tables.js'
import { WC_URL } from './support/import-env.js'
import { ALL_ENTITIES, importStore, openStoreApp, type StoreApp } from './support/store-app.js'
import {
  arbStore,
  fixtureStore,
  personalTokens,
  wooStoreFetch,
  type Rec,
  type WooStore,
} from './support/woo-store.js'

// What an import keeps of the people in a WooCommerce store, and whom it emails: whole imports of generated stores
// whose every personal value is a token no other string holds, on a store built from the platform's dist through
// createApp (`pnpm build` first), read back from every table, every read-model document, the state file, the journal
// and the report.

afterEach(() => {
  vi.unstubAllGlobals()
})

const hash12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)

const personalStores = arbStore({
  products: fc.integer({ min: 1, max: 4 }),
  categories: 3,
  customers: 4,
  orders: 6,
  reviews: 3,
  pii: true,
})

/** Each source order the import holds, with the order the store made of it. */
async function importedOrders(
  env: StoreApp,
  store: WooStore,
): Promise<Array<{ source: Rec; order: Order }>> {
  const state = await loadState(env.statePath)
  const out: Array<{ source: Rec; order: Order }> = []
  for (const source of store.orders) {
    const id = state?.wcToNymbalOrder[String(source['id'])]
    if (id !== undefined) out.push({ source, order: await env.app.services.order.getById(id) })
  }
  return out
}

/** Where each token turns up, case-insensitively: a table row, a read-model document, the files, the report. */
async function leaks(env: StoreApp, tokens: string[], report: string): Promise<string[]> {
  await env.app.relay.drain()
  const places: Record<string, string> = {
    tables: JSON.stringify(tableSnapshot(env.dbPath, () => true)),
    readModels: JSON.stringify(await documentModelsOf(env.app.platform.documentStore)),
    stateFile: await readFile(env.statePath, 'utf8'),
    journal: await readFile(journalPathFor(env.statePath), 'utf8').catch(() => ''),
    report,
  }
  return Object.entries(places).flatMap(([where, text]) => {
    const lower = text.toLowerCase()
    return tokens.filter((t) => lower.includes(t.toLowerCase())).map((t) => `${where}: ${t}`)
  })
}

const addr = (a: unknown) => a as Record<string, string>

describe('AC-1: under --gdpr an import keeps no personal value of any customer or order', () => {
  it("AC-1: for generated stores of guest and registered orders at concurrency 1-4, a gdpr import of all five entities leaves no token in any table, read model, state file, journal or report; each order's email is its customer's anonymised one (the row's, when imported) or a guest address of its own, and each address keeps the source country and region; without gdpr the order keeps the billing email, names and street", async () => {
    await fc.assert(
      fc.asyncProperty(
        personalStores,
        fc.integer({ min: 1, max: 4 }),
        async (store, concurrency) => {
          const env = await openStoreApp()
          try {
            const report = await importStore(env, { store, gdpr: true, concurrency })
            const state = (await loadState(env.statePath))!
            const pairs = await importedOrders(env, store)
            const rowEmail = (customerId: string) =>
              env.rows<{ email: string }>('SELECT email FROM customers WHERE id = ?', customerId)[0]
                ?.email

            expect(await leaks(env, personalTokens(store), formatReport(report, 'store'))).toEqual(
              [],
            )

            expect(
              pairs.map(({ order }) => ({
                email: order.email,
                billTo: [order.billingAddress.country, order.billingAddress.region],
                shipTo: [order.shippingAddress.country, order.shippingAddress.region],
              })),
            ).toEqual(
              pairs.map(({ source }) => {
                const customerId = source['customer_id'] as number
                const billing = addr(source['billing'])
                const shipping = addr(source['shipping'])
                const shipTo = shipping['country'] !== '' ? shipping : billing
                return {
                  email:
                    customerId > 0
                      ? `customer-${hash12(String(customerId))}@imported.nymbal.local`
                      : `order-${hash12(String(source['id']))}@imported.nymbal.local`,
                  billTo: [billing['country'], billing['state']],
                  shipTo: [shipTo['country'], shipTo['state']],
                }
              }),
            )

            const ofImportedCustomer = pairs.filter(
              ({ source }) => state.wcToNymbalCustomer[String(source['customer_id'])] !== undefined,
            )
            expect(ofImportedCustomer.map(({ order }) => order.email)).toEqual(
              ofImportedCustomer.map(({ source }) =>
                rowEmail(state.wcToNymbalCustomer[String(source['customer_id'])]!),
              ),
            )

            const guestEmails = pairs
              .filter(({ source }) => source['customer_id'] === 0)
              .map(({ order }) => order.email)
            expect(new Set(guestEmails).size).toBe(guestEmails.length)
          } finally {
            await env.close()
          }
        },
      ),
      { numRuns: 12 },
    )

    await fc.assert(
      fc.asyncProperty(personalStores, async (store) => {
        const env = await openStoreApp()
        try {
          await importStore(env, { store, gdpr: false })
          const pairs = await importedOrders(env, store)

          expect(
            pairs.map(({ order }) => [
              order.email,
              order.billingAddress.firstName,
              order.billingAddress.lastName,
              order.billingAddress.addressLine1,
            ]),
          ).toEqual(
            pairs.map(({ source }) => {
              const billing = addr(source['billing'])
              return [
                billing['email'],
                billing['first_name'],
                billing['last_name'],
                billing['address_1'],
              ]
            }),
          )
        } finally {
          await env.close()
        }
      }),
      { numRuns: 5 },
    )
  }, 600_000)
})

describe('AC-3: the dry-run plan says what --gdpr leaves behind', () => {
  const PERSONAL = [
    'billing.email',
    'billing.first_name',
    'billing.last_name',
    'billing.phone',
    'billing.address_1',
    'billing.postcode',
    'shipping.first_name',
    'shipping.address_1',
    'customer_note',
  ]

  async function planOf(store: WooStore, gdpr: boolean): Promise<ImportPlan> {
    vi.stubGlobal('fetch', wooStoreFetch(store).fetch)
    try {
      return await planWooCommerceImport(
        {
          credentials: { url: WC_URL, consumerKey: 'ck_test', consumerSecret: 'cs_test' },
          entities: ALL_ENTITIES,
          gdpr,
          currency: 'GBP',
          concurrency: 1,
        },
        { existing: null },
      )
    } finally {
      vi.unstubAllGlobals()
    }
  }

  it("AC-3: for an order carrying every personal field, the plan under --gdpr lists each of them among the orders' unmapped fields, and without it lists none", async () => {
    const base = fixtureStore()
    const order = base.orders[0]!
    const store = fixtureStore({
      orders: [
        {
          ...order,
          billing: { ...addr(order['billing']), phone: '07700900001', company: 'Acme' },
          shipping: {
            ...addr(order['shipping']),
            first_name: 'Bo',
            address_1: '2 Ship St',
            phone: '07700900002',
          },
          customer_note: 'ring twice',
        },
      ],
    })
    const listed = (plan: ImportPlan) =>
      PERSONAL.filter((f) => plan.unmapped.orders.some((u) => u.field === f))

    expect({
      gdpr: listed(await planOf(store, true)),
      plain: listed(await planOf(store, false)),
    }).toEqual({ gdpr: PERSONAL, plain: [] })
  })
})

describe('AC-4: an import emails no one, and registration still welcomes', () => {
  const customers: Rec[] = [1, 2, 3].map((id) => {
    const email = `shopper${id}@example.com`
    const address = {
      first_name: `First${id}`,
      last_name: `Last${id}`,
      company: '',
      address_1: `${id} Mill Lane`,
      address_2: '',
      city: 'York',
      state: 'yorkshire',
      postcode: `YO${id} 1AA`,
      country: 'GB',
      phone: '',
    }
    return {
      id,
      email,
      first_name: `First${id}`,
      last_name: `Last${id}`,
      username: `shopper${id}`,
      billing: { ...address, email },
      shipping: address,
      meta_data: [],
      date_created: '2024-01-15T10:00:00',
    }
  })

  function createdPayloads(env: StoreApp): Array<Record<string, unknown>> {
    return env
      .rows<{
        envelope: string
      }>("SELECT envelope FROM events WHERE type = 'customer.created.v1' ORDER BY seq")
      .map((r) => (JSON.parse(r.envelope) as { payload: Record<string, unknown> }).payload)
  }

  it("AC-4: with a recording email adapter, an import of all five entities with gdpr and then into a fresh store without it sends nothing and logs each customer.created.v1 with origin 'import'; a customer who registers afterwards gets exactly one welcome, and that event has no origin", async () => {
    const base = fixtureStore()
    const source = fixtureStore({
      customers,
      orders: [
        { ...base.orders[0]!, id: 7001, number: '7001', customer_id: 2 },
        { ...base.orders[0]!, id: 7002, number: '7002', customer_id: 0 },
      ],
    })
    const outcome: unknown[] = []
    for (const gdpr of [true, false]) {
      const mail = createTestMailAdapter()
      const env = await openStoreApp({ email: mail })
      try {
        await importStore(env, { store: source, gdpr })
        await env.app.relay.drain()
        const imported = createdPayloads(env)
        const importSends = mail.sent.map((m) => `${m.template} to ${m.to}`)

        const email = `new-shopper-${String(gdpr)}@example.com`
        const { customer } = await env.app.services.auth.register({
          email,
          password: 'a long enough store password 42',
        })
        await env.app.relay.drain()
        const registered = createdPayloads(env).filter((p) => p['customerId'] === customer.id)

        outcome.push({
          gdpr,
          importSends,
          importEvents: imported.length,
          importOrigins: imported.map((p) => p['origin'] ?? 'none'),
          registerSends: mail.sent.slice(importSends.length).map((m) => [m.template, m.to]),
          registerOrigins: registered.map((p) => ('origin' in p ? p['origin'] : 'none')),
        })
      } finally {
        await env.close()
      }
    }

    expect(outcome).toEqual(
      [true, false].map((gdpr) => ({
        gdpr,
        importSends: [],
        importEvents: customers.length,
        importOrigins: customers.map(() => 'import'),
        registerSends: [['welcome', `new-shopper-${String(gdpr)}@example.com`]],
        registerOrigins: ['none'],
      })),
    )
  }, 120_000)
})
