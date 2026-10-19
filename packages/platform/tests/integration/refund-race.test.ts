import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refundRaceSuite } from '../support/suites/refund-race.js'

// P1-13 AC-5 on a SQLite file (the lock is BEGIN IMMEDIATE).

refundRaceSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'p1-13-refund-race-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
