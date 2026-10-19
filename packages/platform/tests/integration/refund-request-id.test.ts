import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refundRequestIdSuite } from '../support/suites/refund-request-id.js'

// P1-13 store walk (`standing.submit-once-admin`): a repeated refund requestId on a SQLite file.

refundRequestIdSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-13-refund-request-id-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
