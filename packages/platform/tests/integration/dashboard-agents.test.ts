import { createKernel } from '../support/kernel.js'
import { dashboardAgentsSuite } from '../support/suites/dashboard-agents.js'

// AC-6 on SQLite, over HTTP on a served kernel.

dashboardAgentsSuite(
  'sqlite',
  (configure) => createKernel({ dialect: 'sqlite', ...(configure !== undefined && { configure }) }),
  { runs: 12 },
)
