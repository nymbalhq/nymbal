import { fileURLToPath } from 'node:url'
import { createCommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createKernel } from '../support/kernel.js'
import { emailFeedbackSuite } from '../support/suites/email-feedback.js'
import { emailSuppressionListSuite } from '../support/suites/email-suppression-list.js'

// Email bounce and complaint webhooks on SQLite; Postgres runs the same suite, its concurrent replays truly
// overlapping.

emailFeedbackSuite('sqlite', {
  open: (opts) => createKernel({ dialect: 'sqlite', ...opts }),
  propertyRuns: 20,
})

// The suppression list on SQLite: here, not beside the repository, since Stryker's unit sandbox leaves tests/ out.
emailSuppressionListSuite('sqlite', {
  open: async () => {
    const store = createCommandStore(
      // @ts-expect-error minimal config
      { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
      { sqlitePath: ':memory:' },
    )
    await runMigrations(store, {
      migrationsRoot: fileURLToPath(new URL('../../migrations', import.meta.url)),
    })
    return store
  },
  propertyRuns: 50,
})
