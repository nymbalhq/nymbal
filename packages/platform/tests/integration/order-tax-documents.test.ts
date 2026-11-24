import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { orderTaxDocumentsSuite } from '../support/suites/order-tax-documents.js'

// AC-11 on a SQLite file.

orderTaxDocumentsSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'order-tax-documents-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
