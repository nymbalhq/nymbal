import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { providerRefundSuite } from '../support/suites/provider-refunds.js'

providerRefundSuite(
  'sqlite',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-refunds-'))
    return {
      target: join(dir, 'store.sqlite'),
      async drop() {
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
  10,
)
