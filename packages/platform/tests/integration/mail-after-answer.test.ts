import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel } from '../support/kernel.js'
import { mailAfterAnswerSuite } from '../support/suites/mail-after-answer.js'

// Forgot, resend and register answering before their mail, and a crash between the answer and the mail, on SQLite.

mailAfterAnswerSuite('sqlite', {
  open: (opts) => createKernel({ dialect: 'sqlite', ...opts }),
  database: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-after-answer-'))
    const sqlitePath = join(dir, 'store.sqlite')
    return {
      open: (opts) => createKernel({ dialect: 'sqlite', sqlitePath, ...opts }),
      async drop() {
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
})
