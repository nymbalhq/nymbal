import { describe, expect, it } from 'vitest'
import { NotFoundError, ValidationError, EVT_CUSTOMER_UPDATED } from '@nymbalhq/types'
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
import { runAsActor } from '../audit/actor.js'
import { auditedCommand } from '../audit/audit.js'
import { listAuditEntries } from '../repositories/audit-entry.js'
import type { CommandStore } from '../db/command-store.js'
import type { EventPublisher } from '../events/publisher.js'
import { toCustomerSnapshot } from '../history/views.js'

async function setup() {
  const commandStore = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(commandStore, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const logger = createLogger({ pretty: false, level: 'error' })
  const eventBus = new InProcessEventBus({ logger })
  const repos = buildRepositories(commandStore, documentStore)
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
  const customerService = createCustomerService({ repos, publisher, logger })
  return { auth, customerService, eventBus, commandStore, repos, logger }
}

const addr = {
  firstName: 'Jane',
  lastName: 'Doe',
  addressLine1: '1 Test St',
  city: 'London',
  region: 'England',
  postalCode: 'SW1A 1AA',
  country: 'GB',
  isDefaultBilling: false,
  isDefaultShipping: false,
}

describe('CustomerService', () => {
  it('getProfile returns customer without passwordHash', async () => {
    const { auth, customerService, commandStore } = await setup()
    const { customer } = await auth.register({ email: 'profile@test.com', password: 'password123' })
    const profile = await customerService.getProfile(customer.id)
    expect(profile.email).toBe('profile@test.com')
    expect('passwordHash' in profile).toBe(false)
    await commandStore.close()
  })

  it('getProfile throws NotFoundError for unknown id', async () => {
    const { customerService, commandStore } = await setup()
    await expect(customerService.getProfile('ghost-id')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('updateProfile patches fields and emits customer.updated', async () => {
    const { auth, customerService, eventBus, commandStore } = await setup()
    const events: unknown[] = []
    await eventBus.subscribe(EVT_CUSTOMER_UPDATED, (e) => {
      events.push(e.payload)
    })
    const { customer } = await auth.register({ email: 'update@test.com', password: 'password123' })
    const updated = await customerService.updateProfile(customer.id, { firstName: 'Updated' })
    expect(updated.firstName).toBe('Updated')
    expect(events.length).toBeGreaterThanOrEqual(1)
    await commandStore.close()
  })

  it('listAddresses returns empty array for new customer', async () => {
    const { auth, customerService, commandStore } = await setup()
    const { customer } = await auth.register({ email: 'addrs@test.com', password: 'password123' })
    const addrs = await customerService.listAddresses(customer.id)
    expect(addrs).toEqual([])
    await commandStore.close()
  })

  it('addAddress adds and returns address', async () => {
    const { auth, customerService, commandStore } = await setup()
    const { customer } = await auth.register({ email: 'addaddr@test.com', password: 'password123' })
    const added = await customerService.addAddress(customer.id, addr)
    expect(added.id).toBeTruthy()
    expect(added.city).toBe('London')
    await commandStore.close()
  })

  it('addAddress sets default billing/shipping exclusively', async () => {
    const { auth, customerService, commandStore } = await setup()
    const { customer } = await auth.register({ email: 'default@test.com', password: 'password123' })
    const first = await customerService.addAddress(customer.id, { ...addr, isDefaultBilling: true })
    const second = await customerService.addAddress(customer.id, {
      ...addr,
      isDefaultBilling: true,
    })
    const list = await customerService.listAddresses(customer.id)
    const firstRefresh = list.find((a) => a.id === first.id)
    expect(firstRefresh?.isDefaultBilling).toBe(false)
    expect(second.isDefaultBilling).toBe(true)
    await commandStore.close()
  })

  it('deleteAddress removes address', async () => {
    const { auth, customerService, commandStore } = await setup()
    const { customer } = await auth.register({ email: 'deladdr@test.com', password: 'password123' })
    const a1 = await customerService.addAddress(customer.id, addr)
    const a2 = await customerService.addAddress(customer.id, addr)
    await customerService.deleteAddress(customer.id, a1.id)
    const list = await customerService.listAddresses(customer.id)
    expect(list.find((a) => a.id === a1.id)).toBeUndefined()
    expect(list.find((a) => a.id === a2.id)).toBeDefined()
    await commandStore.close()
  })

  it('deleteAddress throws NotFoundError for unknown id', async () => {
    const { auth, customerService, commandStore } = await setup()
    const { customer } = await auth.register({
      email: 'delnotfound@test.com',
      password: 'password123',
    })
    await customerService.addAddress(customer.id, addr)
    await expect(customerService.deleteAddress(customer.id, 'nope')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('deleteAddress throws ValidationError when removing last address', async () => {
    const { auth, customerService, commandStore } = await setup()
    const { customer } = await auth.register({
      email: 'lastaddr@test.com',
      password: 'password123',
    })
    const only = await customerService.addAddress(customer.id, addr)
    await expect(customerService.deleteAddress(customer.id, only.id)).rejects.toThrow(
      ValidationError,
    )
    await commandStore.close()
  })

  it('addAddress with isDefaultShipping clears other default shipping', async () => {
    const { auth, customerService, commandStore } = await setup()
    const { customer } = await auth.register({ email: 'defship@test.com', password: 'password123' })
    const first = await customerService.addAddress(customer.id, {
      ...addr,
      isDefaultShipping: true,
    })
    const second = await customerService.addAddress(customer.id, {
      ...addr,
      isDefaultShipping: true,
    })
    const list = await customerService.listAddresses(customer.id)
    const firstRefresh = list.find((a) => a.id === first.id)
    expect(firstRefresh?.isDefaultShipping).toBe(false)
    expect(second.isDefaultShipping).toBe(true)
    await commandStore.close()
  })

  it('updateProfile throws NotFoundError for unknown customer', async () => {
    const { customerService, commandStore } = await setup()
    await expect(customerService.updateProfile('ghost', { firstName: 'x' })).rejects.toThrow(
      NotFoundError,
    )
    await commandStore.close()
  })
})

// A service notes the command it runs and the records it touches into the open command, and writes no row itself.
// Under an actor with no opener (an import), each transaction a service notes in is a command of its own.
const importer = { kind: 'import', id: 'woocommerce' } as const
const admin = { kind: 'admin', id: 'admin-1' } as const

const noted = async (commandStore: CommandStore) =>
  (await commandStore.read((tx) => listAuditEntries(tx, { order: 'asc', limit: 100 }))).map(
    (e) => ({
      actor: e.actor,
      command: e.command,
      subjects: e.subjects,
      outcome: e.outcome,
      status: e.responseStatus,
    }),
  )

describe('CustomerService: audit notes', () => {
  it('AC-2: under an actor with no opener, a profile update, an address added and one removed each leave one applied entry naming the customer', async () => {
    const { auth, customerService, commandStore } = await setup()
    const { customer } = await auth.register({ email: 'audited@test.com', password: 'password123' })
    await runAsActor(importer, () => customerService.updateProfile(customer.id, { firstName: 'A' }))
    const kept = await runAsActor(importer, () => customerService.addAddress(customer.id, addr))
    const removed = await runAsActor(importer, () => customerService.addAddress(customer.id, addr))
    await runAsActor(importer, () => customerService.deleteAddress(customer.id, removed.id))
    expect(await customerService.listAddresses(customer.id)).toHaveLength(1)
    expect(kept.id).not.toBe(removed.id)
    const subjects = [{ type: 'customer', id: customer.id }]
    expect(await noted(commandStore)).toEqual([
      { actor: importer, command: 'customer.update', subjects, outcome: 'applied', status: null },
      {
        actor: importer,
        command: 'customer.addAddress',
        subjects,
        outcome: 'applied',
        status: null,
      },
      {
        actor: importer,
        command: 'customer.addAddress',
        subjects,
        outcome: 'applied',
        status: null,
      },
      {
        actor: importer,
        command: 'customer.removeAddress',
        subjects,
        outcome: 'applied',
        status: null,
      },
    ])
    await commandStore.close()
  })

  it('AC-2: a refused address removal is recorded as customer.removeAddress refused, naming the customer', async () => {
    const { auth, customerService, commandStore } = await setup()
    const { customer } = await auth.register({ email: 'refused@test.com', password: 'password123' })
    await expect(
      runAsActor(admin, () =>
        auditedCommand(commandStore, undefined, () =>
          customerService.deleteAddress(customer.id, 'no-such-address'),
        ),
      ),
    ).rejects.toThrow(NotFoundError)
    expect(await noted(commandStore)).toEqual([
      {
        actor: admin,
        command: 'customer.removeAddress',
        subjects: [{ type: 'customer', id: customer.id }],
        outcome: 'refused',
        status: 404,
      },
    ])
    await commandStore.close()
  })
})

describe('CustomerService: admin notes', () => {
  const first = {
    body: 'Called about a late parcel',
    actor: 'admin-1',
    at: '2026-10-01T09:00:00.000Z',
  }
  const second = { body: 'Refund agreed', actor: 'admin-2', at: '2026-10-02T10:30:00.000Z' }

  it('addNote appends each note to metadata.adminNotes in order, keeping the earlier ones', async () => {
    const { auth, customerService, commandStore } = await setup()
    const { customer } = await auth.register({ email: 'notes@test.com', password: 'password123' })
    await customerService.addNote(customer.id, first)
    expect((await customerService.getProfile(customer.id)).metadata.adminNotes).toEqual([first])
    await customerService.addNote(customer.id, second)
    expect((await customerService.getProfile(customer.id)).metadata.adminNotes).toEqual([
      first,
      second,
    ])
    await commandStore.close()
  })

  it('addNote publishes customer.updated carrying the snapshot of the customer as written', async () => {
    const { auth, customerService, eventBus, commandStore } = await setup()
    const { customer } = await auth.register({ email: 'noteevt@test.com', password: 'password123' })
    const events: unknown[] = []
    await eventBus.subscribe(EVT_CUSTOMER_UPDATED, (e) => {
      events.push(e.payload)
    })
    await customerService.addNote(customer.id, first)
    const profile = await customerService.getProfile(customer.id)
    expect(events).toEqual([{ customerId: customer.id, customer: toCustomerSnapshot(profile) }])
    await commandStore.close()
  })

  it('addNote keeps no note when publishing customer.updated fails, as both share one transaction', async () => {
    const { auth, customerService, commandStore, repos, logger } = await setup()
    const { customer } = await auth.register({ email: 'noterb@test.com', password: 'password123' })
    await customerService.addNote(customer.id, first)
    const failing = {
      publish: async () => {
        throw new Error('outbox unavailable')
      },
    } as unknown as EventPublisher
    const withFailingPublisher = createCustomerService({ repos, publisher: failing, logger })
    await expect(withFailingPublisher.addNote(customer.id, second)).rejects.toThrow(
      'outbox unavailable',
    )
    expect((await customerService.getProfile(customer.id)).metadata.adminNotes).toEqual([first])
    await commandStore.close()
  })

  it('addNote on an unknown customer throws the customer not-found error and publishes nothing', async () => {
    const { customerService, eventBus, commandStore } = await setup()
    const events: unknown[] = []
    await eventBus.subscribe(EVT_CUSTOMER_UPDATED, (e) => {
      events.push(e.payload)
    })
    const refusal = customerService.addNote('ghost', first)
    await expect(refusal).rejects.toThrow(NotFoundError)
    await expect(refusal).rejects.toThrow('customer not found: ghost')
    expect(events).toEqual([])
    await commandStore.close()
  })

  it('addNote under an actor with no opener leaves one applied customer.addNote entry naming the customer', async () => {
    const { auth, customerService, commandStore } = await setup()
    const { customer } = await auth.register({ email: 'noteaud@test.com', password: 'password123' })
    await runAsActor(importer, () => customerService.addNote(customer.id, first))
    expect(await noted(commandStore)).toEqual([
      {
        actor: importer,
        command: 'customer.addNote',
        subjects: [{ type: 'customer', id: customer.id }],
        outcome: 'applied',
        status: null,
      },
    ])
    await commandStore.close()
  })
})
