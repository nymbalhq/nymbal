import { createKernel } from '../support/kernel.js'
import { historyAsOfSuite } from '../support/suites/history-as-of.js'

// AC-1 on SQLite: a kernel from `src/`, served over HTTP.

historyAsOfSuite('sqlite', () => createKernel({ dialect: 'sqlite' }), { runs: 6, maxSteps: 14 })
