import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { EVT_CUSTOMER_CREATED, EVT_CUSTOMER_UPDATED, type CustomerAddress } from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher, createRelay } from '../index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createAuthService } from './auth-service.js'
import { createCustomerService } from './customer-service.js'
import { createLogger } from '../logger.js'

// AC-5 (decision 2): `customer.created` (register and import) and
// `customer.updated` (profile, add address, delete address) carry `customer`, equal to the customer row after the
// write read as a CustomerSnapshot: exactly {id, email, firstName, lastName, phone, addresses, createdAt}, so no
// passwordHash, roles, metadata, requiresPasswordReset or stats. The V1 fields stay: `customerId`, and `email` on
// created. Events are read from the event log the command wrote, the row from the repository after it.
// Kills: the snapshot taken before the write; a snapshot that leaks the hash, the roles or the metadata; the V1 fields
// replaced by the snapshot.

const SNAPSHOT_KEYS = ['addresses', 'createdAt', 'email', 'firstName', 'id', 'lastName', 'phone']

async function setup() {
  const commandStore = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(commandStore, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const logger = createLogger({ pretty: false, level: 'error' })
  const eventBus = new InProcessEventBus({ logger })
  const repos = buildRepositories(commandStore, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  const publisher = wirePublisher(
    { createEventPublisher, createRelay },
    { store: commandStore, eventLog: repos.eventLog, eventBus, logger },
  ).publisher
  const auth = createAuthService({
    repos,
    publisher,
    logger,
    jwtSecret: 'test-secret-32-characters-long-x',
    accessTtl: '15m',
    refreshTtl: '7d',
  })
  const customers = createCustomerService({ repos, publisher, logger })

  /** The customer row as a CustomerSnapshot, read after the write. */
  async function snapshotOfRow(id: string): Promise<Record<string, unknown>> {
    const row = await commandStore.read((tx) => repos.customer.findById(tx, id))
    if (!row) throw new Error(`no customer row ${id}`)
    const json = JSON.parse(JSON.stringify(row)) as Record<string, unknown>
    return Object.fromEntries(SNAPSHOT_KEYS.map((key) => [key, json[key]]))
  }

  /** The payloads of the logged events of `type` about `customerId`, in seq order. */
  async function payloads(type: string, customerId: string): Promise<Record<string, unknown>[]> {
    const rows = await commandStore.read((tx) => repos.eventLog.listAll(tx))
    return rows
      .filter((row) => row.event.type === type)
      .map((row) => JSON.parse(JSON.stringify(row.event.payload)) as Record<string, unknown>)
      .filter((p) => p['customerId'] === customerId)
  }

  return { auth, customers, repos, commandStore, snapshotOfRow, payloads }
}

const addr = (line: string, defaults = false): Omit<CustomerAddress, 'id'> => ({
  firstName: 'Jane',
  lastName: 'Doe',
  addressLine1: line,
  city: 'London',
  region: 'England',
  postalCode: 'SW1A 1AA',
  country: 'GB',
  isDefaultBilling: defaults,
  isDefaultShipping: defaults,
})

describe('AC-5: customer events carry a snapshot with no secrets', () => {
  it('AC-5: register’s customer.created carries customer equal to the row’s snapshot, its keys exactly Decision 2’s, beside customerId and email', async () => {
    const { auth, commandStore, snapshotOfRow, payloads } = await setup()
    const { customer } = await auth.register({
      email: 'snap@test.com',
      password: 'password123',
      firstName: 'Ada',
      lastName: 'Lovelace',
      phone: '+441234567890',
    })
    const [created] = await payloads(EVT_CUSTOMER_CREATED, customer.id)
    expect(Object.keys((created?.['customer'] ?? {}) as object).sort()).toEqual(SNAPSHOT_KEYS)
    expect(created?.['customer']).toEqual(await snapshotOfRow(customer.id))
    expect([created?.['customerId'], created?.['email']]).toEqual([customer.id, customer.email])
    await commandStore.close()
  })

  it('AC-5: import’s customer.created carries the row’s snapshot (its addresses included), and neither its metadata nor its placeholder hash', async () => {
    const { auth, commandStore, snapshotOfRow, payloads } = await setup()
    const imported = await auth.importCustomer({
      email: 'Imported@Test.com',
      firstName: 'Imo',
      addresses: [{ ...addr('9 Import Way', true), id: 'addr-imported' }],
      metadata: { note: 'from woo', wooId: 42 },
    })
    const [created] = await payloads(EVT_CUSTOMER_CREATED, imported.id)
    expect(created?.['customer']).toEqual(await snapshotOfRow(imported.id))
    expect(Object.keys((created?.['customer'] ?? {}) as object).sort()).toEqual(SNAPSHOT_KEYS)
    const text = JSON.stringify(created)
    expect(['IMPORTED_NO_PASSWORD', 'wooId', 'roles'].filter((s) => text.includes(s))).toEqual([])
    expect([created?.['customerId'], created?.['email']]).toEqual([imported.id, imported.email])
    await commandStore.close()
  })

  it('AC-5: property: after each generated profile edit, address add and address delete, the customer.updated it logs carries the row’s snapshot after that write, and customerId', async () => {
    const { auth, customers, commandStore, snapshotOfRow, payloads } = await setup()
    // One registration for every run: bcrypt is the cost, and each run's edits continue from the row as the last left it.
    const { customer } = await auth.register({ email: 'prop@test.com', password: 'password123' })
    const op = fc.oneof(
      fc.record({
        kind: fc.constant('profile' as const),
        patch: fc.record(
          {
            firstName: fc.string({ maxLength: 12 }),
            lastName: fc.string({ maxLength: 12 }),
            phone: fc.stringMatching(/^\+44\d{6,10}$/),
          },
          { requiredKeys: [] },
        ),
      }),
      fc.record({
        kind: fc.constant('add' as const),
        line: fc.string({ minLength: 1, maxLength: 20 }),
        defaults: fc.boolean(),
      }),
      fc.record({ kind: fc.constant('delete' as const), pick: fc.nat() }),
    )
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 6 }), async (ops) => {
        for (const o of ops) {
          const before = (await payloads(EVT_CUSTOMER_UPDATED, customer.id)).length
          if (o.kind === 'profile') await customers.updateProfile(customer.id, o.patch)
          else if (o.kind === 'add')
            await customers.addAddress(customer.id, addr(o.line, o.defaults))
          else {
            const addresses = await customers.listAddresses(customer.id)
            if (addresses.length < 2) continue
            await customers.deleteAddress(customer.id, addresses[o.pick % addresses.length]!.id)
          }
          const updated = await payloads(EVT_CUSTOMER_UPDATED, customer.id)
          expect(updated.length, o.kind).toBe(before + 1)
          const last = updated.at(-1)!
          expect(Object.keys((last['customer'] ?? {}) as object).sort(), o.kind).toEqual(
            SNAPSHOT_KEYS,
          )
          expect(last['customer'], o.kind).toEqual(await snapshotOfRow(customer.id))
          expect(last['customerId'], o.kind).toBe(customer.id)
        }
      }),
      { numRuns: 25, endOnFailure: true },
    )
    await commandStore.close()
  })
})
