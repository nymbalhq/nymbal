import { createHash } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import type { CustomerAddress } from '@nymbal/types'
import type { ImportCustomerInput } from '@nymbal/platform'
import type { WcCustomer, WcAddress } from '../client.js'

function mapAddress(a: WcAddress): CustomerAddress {
  const addr: CustomerAddress = {
    id: uuidv7(),
    firstName: a.first_name,
    lastName: a.last_name,
    addressLine1: a.address_1 || '—',
    city: a.city,
    region: a.state,
    postalCode: a.postcode,
    country: a.country || 'US',
    isDefaultBilling: true,
    isDefaultShipping: false,
  }
  if (a.address_2) addr.addressLine2 = a.address_2
  if (a.phone) addr.phone = a.phone
  if (a.company) addr.company = a.company
  return addr
}

export function mapCustomer(wc: WcCustomer, gdpr: boolean): ImportCustomerInput {
  const wcMeta: Record<string, unknown> = { customerId: wc.id, syncedAt: new Date().toISOString() }

  if (gdpr) {
    const hash = createHash('sha256').update(String(wc.id)).digest('hex').slice(0, 12)
    return {
      email: `customer-${hash}@imported.nymbal.local`,
      metadata: { woocommerce: wcMeta },
    }
  }

  const input: ImportCustomerInput = {
    email: wc.email,
    metadata: { woocommerce: wcMeta },
  }
  if (wc.first_name) input.firstName = wc.first_name
  if (wc.last_name) input.lastName = wc.last_name
  if (wc.billing.address_1) input.addresses = [mapAddress(wc.billing)]
  return input
}
