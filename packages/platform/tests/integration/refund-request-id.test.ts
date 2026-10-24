import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refundRequestIdSuite } from '../support/suites/refund-request-id.js'

// A repeated refund requestId moves money once, on a SQLite file.

refundRequestIdSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'money-refund-request-id-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
