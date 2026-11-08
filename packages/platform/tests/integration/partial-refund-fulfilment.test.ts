import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { partialRefundFulfilmentSuite } from '../support/suites/partial-refund-fulfilment.js'

// A partially refunded order moved on through the admin's routes, on a SQLite file.

partialRefundFulfilmentSuite(
  'sqlite',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'partial-refund-fulfilment-'))
    return {
      target: join(dir, 'store.sqlite'),
      async drop() {
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
  { runs: 6 },
)
