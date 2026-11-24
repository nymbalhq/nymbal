import { createDatabase, postgresServerUrl } from '../support/postgres.js'
import { orderTaxDocumentsSuite } from '../support/suites/order-tax-documents.js'

// AC-11 on Postgres, a fresh database for the file. Refuses to load without NYMBAL_TEST_POSTGRES_URL.

const serverUrl = postgresServerUrl()

orderTaxDocumentsSuite('postgres', async () => {
  const db = await createDatabase(serverUrl, 'order_tax_documents')
  return { target: db.url, drop: () => db.drop() }
})
