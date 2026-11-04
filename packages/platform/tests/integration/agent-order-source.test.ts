import { createKernel } from '../support/kernel.js'
import { agentOrderSourceSuite } from '../support/suites/agent-order-source.js'

// AC-4 on SQLite, over HTTP on a kernel served with its agent surfaces.

agentOrderSourceSuite('sqlite', () => createKernel({ dialect: 'sqlite' }), { runs: 10 })
