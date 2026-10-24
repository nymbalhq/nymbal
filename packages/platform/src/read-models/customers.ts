import { customerProjection } from '../handlers/projections/customer-projection.js'
import { buildCustomerProfile, CUSTOMER_PROFILES } from './builders.js'
import type { ReadModel } from './model.js'

export const customers: ReadModel = {
  name: 'customers',
  target: 'documents',
  collections: [CUSTOMER_PROFILES],

  async *rebuild(ctx) {
    const { repos } = ctx.deps
    for await (const page of ctx.pages('customers', (tx, p) => repos.customer.listPage(tx, p))) {
      for (const c of page) {
        yield { collection: CUSTOMER_PROFILES, key: c.id, doc: buildCustomerProfile(c) }
      }
    }
  },

  handlers({ documentStore, logger, repos }) {
    return customerProjection({
      documentStore,
      logger,
      customerRepo: repos.customer,
      orderRepo: repos.order,
    })
  },
}
