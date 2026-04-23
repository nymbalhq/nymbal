import type { Customer, CustomerAddress } from '@nymbal/types'
import { createAddress } from './order.js'
import { nextId, isoDate } from './prng.js'

export function createCustomerAddress(overrides?: Partial<CustomerAddress>): CustomerAddress {
  return {
    id: nextId(),
    isDefaultBilling: false,
    isDefaultShipping: false,
    ...createAddress(),
    ...overrides,
  }
}

export function createCustomer(overrides?: Partial<Customer>): Customer {
  const id = nextId()
  return {
    id,
    email: `test-${id.slice(0, 6)}@example.com`,
    firstName: 'Jane',
    lastName: 'Doe',
    phone: '+44 7700 900000',
    addresses: [],
    orderCount: 0,
    totalSpentMinor: 0,
    metadata: {},
    requiresPasswordReset: false,
    createdAt: isoDate(),
    updatedAt: isoDate(),
    ...overrides,
  }
}
