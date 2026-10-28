import { createKernel } from '../support/kernel.js'
import { inboundWebhooksStore, inboundWebhooksSuite } from '../support/suites/inbound-webhooks.js'

// Inbound webhooks on SQLite; Postgres runs the same suite, the concurrent deliveries there truly overlapping.

inboundWebhooksSuite('sqlite', () => createKernel({ dialect: 'sqlite', ...inboundWebhooksStore() }))
