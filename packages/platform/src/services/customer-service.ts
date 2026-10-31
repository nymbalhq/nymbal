import { v7 as uuidv7 } from 'uuid'
import {
  EVT_CUSTOMER_UPDATED,
  NotFoundError,
  ValidationError,
  type Customer,
  type CustomerAddress,
  type Logger,
} from '@nymbalhq/types'
import { audit } from '../audit/audit.js'
import type { ReadTx } from '../db/command-store.js'
import type { Repositories } from '../repositories/index.js'
import type { EventPublisher } from '../events/publisher.js'
import { toCustomerSnapshot } from '../history/views.js'

export interface ProfileUpdate {
  firstName?: string
  lastName?: string
  phone?: string
}

/** An admin's note on a customer, kept in its metadata. */
export interface CustomerNote {
  body: string
  actor: string
  at: string
}

export interface CustomerService {
  getProfile(customerId: string): Promise<Customer>
  updateProfile(customerId: string, patch: ProfileUpdate): Promise<Customer>
  listAddresses(customerId: string): Promise<CustomerAddress[]>
  addAddress(customerId: string, addr: Omit<CustomerAddress, 'id'>): Promise<CustomerAddress>
  deleteAddress(customerId: string, addressId: string): Promise<void>
  /** Appends `note` to the customer's admin notes. */
  addNote(customerId: string, note: CustomerNote): Promise<void>
}

function stripPassword(c: Customer & { passwordHash: string }): Customer {
  const { passwordHash: _pw, ...rest } = c
  return rest
}

export function createCustomerService(deps: {
  repos: Repositories
  publisher: EventPublisher
  logger: Logger
}): CustomerService {
  const { repos, publisher } = deps
  const { store } = repos.customer

  async function loadOrThrow(tx: ReadTx, id: string): Promise<Customer & { passwordHash: string }> {
    const c = await repos.customer.findById(tx, id)
    if (!c) throw new NotFoundError('customer', id)
    return c
  }

  /** `customer.updated` with the row as the write left it. */
  async function publishUpdated(tx: ReadTx, customerId: string): Promise<Customer> {
    const fresh = stripPassword(await loadOrThrow(tx, customerId))
    await publisher.publish(EVT_CUSTOMER_UPDATED, {
      customerId,
      customer: toCustomerSnapshot(fresh),
    })
    return fresh
  }

  return {
    async getProfile(customerId) {
      return stripPassword(await store.read((tx) => loadOrThrow(tx, customerId)))
    },
    async updateProfile(customerId, patch) {
      return store.transaction(async (tx) => {
        audit.note('customer.update', [{ type: 'customer', id: customerId }])
        await loadOrThrow(tx, customerId)
        const now = new Date()
        await repos.customer.update(tx, customerId, { ...patch, updatedAt: now })
        return publishUpdated(tx, customerId)
      })
    },
    async listAddresses(customerId) {
      const customer = await store.read((tx) => loadOrThrow(tx, customerId))
      return customer.addresses
    },
    async addAddress(customerId, addr) {
      return store.transaction(async (tx) => {
        audit.note('customer.addAddress', [{ type: 'customer', id: customerId }])
        const customer = await loadOrThrow(tx, customerId)
        const newAddr: CustomerAddress = { ...addr, id: uuidv7() }
        const defaultBilling = newAddr.isDefaultBilling
        const defaultShipping = newAddr.isDefaultShipping
        const addresses = customer.addresses.map((a) => ({
          ...a,
          isDefaultBilling: defaultBilling ? false : a.isDefaultBilling,
          isDefaultShipping: defaultShipping ? false : a.isDefaultShipping,
        }))
        addresses.push(newAddr)
        const now = new Date()
        await repos.customer.update(tx, customerId, { addresses, updatedAt: now })
        await publishUpdated(tx, customerId)
        return newAddr
      })
    },
    async deleteAddress(customerId, addressId) {
      await store.transaction(async (tx) => {
        audit.note('customer.removeAddress', [{ type: 'customer', id: customerId }])
        const customer = await loadOrThrow(tx, customerId)
        const addresses = customer.addresses.filter((a) => a.id !== addressId)
        if (addresses.length === customer.addresses.length) {
          throw new NotFoundError('address', addressId)
        }
        if (!addresses.length) {
          throw new ValidationError('Cannot remove last address')
        }
        const now = new Date()
        await repos.customer.update(tx, customerId, { addresses, updatedAt: now })
        await publishUpdated(tx, customerId)
      })
    },
    async addNote(customerId, note) {
      await store.transaction(async (tx) => {
        const customer = await loadOrThrow(tx, customerId)
        audit.note('customer.addNote', [{ type: 'customer', id: customerId }])
        const notes = (customer.metadata.adminNotes as CustomerNote[] | undefined) ?? []
        await repos.customer.update(tx, customerId, {
          metadata: { ...customer.metadata, adminNotes: [...notes, note] },
          updatedAt: new Date(),
        })
        await publishUpdated(tx, customerId)
      })
    },
  }
}
