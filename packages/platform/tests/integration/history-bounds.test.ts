import { createKernel } from '../support/kernel.js'
import { historyBoundsSuite } from '../support/suites/history-bounds.js'

// AC-2 on SQLite: kernels from `src/`, served over HTTP.

historyBoundsSuite('sqlite', () => createKernel({ dialect: 'sqlite' }))
