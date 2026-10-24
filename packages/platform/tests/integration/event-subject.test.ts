import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eventSubjectSuite } from '../support/suites/event-subject.js'

// AC-4 on SQLite: a file per database.

eventSubjectSuite('sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'history-subject-'))
  return {
    target: join(dir, 'store.sqlite'),
    async drop() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
