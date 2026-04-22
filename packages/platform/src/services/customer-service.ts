import { v7 as uuidv7 } from 'uuid'
import {
  EVT_CUSTOMER_UPDATED,
  NotFoundError,
  ValidationError,
  type Customer,
  type CustomerAddress,
  type Logger,
} from '@nymbal/types'
import type { Repositories } from '../repositories/index.js'
import type { EventPublisher } from '../events/publisher.js'

export interface ProfileUpdate {
  firstName?: string
  lastName?: string
  phone?: string
}

export interface CustomerService {
  getProfile(customerId: string): Promise<Customer>
  updateProfile(customerId: string, patch: ProfileUpdate): Promise<Customer>
  listAddresses(customerId: string): Promise<CustomerAddress[]>
  addAddress(customerId: string, addr: Omit<CustomerAddress, 'id'>): Promise<CustomerAddress>
  deleteAddress(customerId: string, addressId: string): Promise<void>
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

  async function loadOrThrow(id: string): Promise<Customer & { passwordHash: string }> {
    const c = await repos.customer.findById(id)
    if (!c) throw new NotFoundError('customer', id)
    return c
  }

  return {
    async getProfile(customerId) {
      return stripPassword(await loadOrThrow(customerId))
    },
    async updateProfile(customerId, patch) {
      const customer = await loadOrThrow(customerId)
      const now = new Date()
      await repos.customer.update(customerId, { ...patch, updatedAt: now })
      await publisher.publish(EVT_CUSTOMER_UPDATED, { customerId })
      const fresh = await loadOrThrow(customerId)
      return stripPassword(fresh)
    },
    async listAddresses(customerId) {
      const customer = await loadOrThrow(customerId)
      return customer.addresses
    },
    async addAddress(customerId, addr) {
      const customer = await loadOrThrow(customerId)
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
      await repos.customer.update(customerId, { addresses, updatedAt: now })
      await publisher.publish(EVT_CUSTOMER_UPDATED, { customerId })
      return newAddr
    },
    async deleteAddress(customerId, addressId) {
      const customer = await loadOrThrow(customerId)
      const addresses = customer.addresses.filter((a) => a.id !== addressId)
      if (addresses.length === customer.addresses.length) {
        throw new NotFoundError('address', addressId)
      }
      if (!addresses.length) {
        throw new ValidationError('Cannot remove last address')
      }
      const now = new Date()
      await repos.customer.update(customerId, { addresses, updatedAt: now })
      await publisher.publish(EVT_CUSTOMER_UPDATED, { customerId })
    },
  }
}
