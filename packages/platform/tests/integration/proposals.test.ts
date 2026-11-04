import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  proposalRacesSuite,
  proposalsSuite,
  type FreshDatabase,
} from '../support/suites/proposals.js'

// Agent writes as proposals on SQLite files: the table, its events, approve and reject, the policies, and the races
// for one row and one decision (the lock is BEGIN IMMEDIATE).

const fresh: FreshDatabase = async (label) => {
  const dir = mkdtempSync(join(tmpdir(), `proposals-${label}-`))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

proposalsSuite('sqlite', fresh)
proposalRacesSuite('sqlite', fresh)
