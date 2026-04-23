import { describe, expect, it } from 'vitest'
import { NotFoundError, ValidationError, EVT_CUSTOMER_UPDATED } from '@nymbal/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher } from '../events/publisher.js'
import { createAuthService } from './auth-service.js'
import { createCustomerService } from './customer-service.js'
import { createLogger } from '../logger.js'

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
  const publisher = createEventPublisher({
    eventBus,
    builderContext: { storeId: 'test', environment: 'development', version: '0.0.0', source: 'test' },
  })
  const auth = createAuthService({
    repos, publisher, logger,
    jwtSecret: 'test-secret-32-characters-long-x',
    accessTtl: '15m', refreshTtl: '7d',
  })
  const customerService = createCustomerService({ repos, publisher, logger })
  return { auth, customerService, eventBus, commandStore }
}

const addr = {
  firstName: 'Jane', lastName: 'Doe',
  addressLine1: '1 Test St', city: 'London',
  region: 'England', postalCode: 'SW1A 1AA', country: 'GB',
  isDefaultBilling: false, isDefaultShipping: false,
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
    await eventBus.subscribe(EVT_CUSTOMER_UPDATED, (e) => { events.push(e.payload) })
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
    const second = await customerService.addAddress(customer.id, { ...addr, isDefaultBilling: true })
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
    const { customer } = await auth.register({ email: 'delnotfound@test.com', password: 'password123' })
    await customerService.addAddress(customer.id, addr)
    await expect(customerService.deleteAddress(customer.id, 'nope')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('deleteAddress throws ValidationError when removing last address', async () => {
    const { auth, customerService, commandStore } = await setup()
    const { customer } = await auth.register({ email: 'lastaddr@test.com', password: 'password123' })
    const only = await customerService.addAddress(customer.id, addr)
    await expect(customerService.deleteAddress(customer.id, only.id)).rejects.toThrow(ValidationError)
    await commandStore.close()
  })
})
