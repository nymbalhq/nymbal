import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTestStore } from '../support/proof-kit.js'
import { openRaw } from '../support/raw.js'
import { checkoutCorrelationSuite } from '../support/suites/correlation-checkout.js'

// P3-01 AC-1 and AC-1b on SQLite (spec P3-01-event-log-surface), over HTTP on startTestStore. The kit runs the built
// kernel: `pnpm build` first.

checkoutCorrelationSuite(
  'sqlite',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p3-01-checkout-'))
    const sqlitePath = join(dir, 'store.sqlite')
    const store = await startTestStore({ sqlitePath })
    const raw = openRaw('sqlite', sqlitePath)
    return {
      store,
      raw,
      async stop() {
        await raw.close()
        await store.stop()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
  { runs: 8 },
)
