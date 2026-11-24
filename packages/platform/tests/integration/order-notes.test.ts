import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel } from '../support/kernel.js'
import { orderNotesMigrationSuite } from '../support/suites/order-notes-migration.js'
import { orderNotesSuite } from '../support/suites/order-notes.js'

// A shopper's checkout note and the staff notes beside it on SQLite; Postgres runs the same suites.

orderNotesSuite('sqlite', {
  open: (opts) => createKernel({ dialect: 'sqlite', ...opts }),
  propertyRuns: 12,
})

orderNotesMigrationSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'staff-notes-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
