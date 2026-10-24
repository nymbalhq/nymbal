// Chaos fixture: a child process that writes rows to a SQLite file and publishes events through its own bus, armed by
// armChaos from the environment (NYMBAL_CHAOS). A subscriber appends every delivered event type to a marker file, so
// the parent can tell a kill before the publish from a kill after it.
//
//   node chaos-child.mjs <sqlite file> <marker file> '<plan JSON>'
//
// plan: an array of { op: 'write', id } | { op: 'publish', type } | { op: 'batch', types } | { op: 'exit', code }
// | { op: 'hang' }. Without an exit or hang op the child exits 0 after the last step.
//
// The bus delivers a batch without going through its own publish(), as a networked bus would, so a chaos wrapper
// that only wraps publish() lets the batch slip past.
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { armChaos } from '@nymbalhq/proof-kit/chaos'
import Database from 'better-sqlite3'

const [dbPath, markerPath, planJson] = process.argv.slice(2)
if (!dbPath || !markerPath || !planJson) {
  console.error('usage: chaos-child.mjs <sqlite file> <marker file> <plan JSON>')
  process.exit(64)
}
const plan = JSON.parse(planJson)

function createBus() {
  const handlers = []
  const deliver = async (event) => {
    for (const handler of handlers) await handler(event)
  }
  return {
    async publish(event) {
      await deliver(event)
    },
    async publishBatch(events) {
      for (const event of events) await deliver(event)
    },
    async subscribe(pattern, handler) {
      handlers.push(handler)
      return { id: randomUUID(), patterns: [].concat(pattern), unsubscribe: async () => {} }
    },
    async unsubscribe() {},
    async close() {},
  }
}

function event(type) {
  return {
    id: randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    source: 'chaos-child',
    correlationId: randomUUID(),
    payload: {},
    metadata: { storeId: 'proof-kit', environment: 'development', version: '0.0.0' },
  }
}

const db = new Database(dbPath)
db.exec('CREATE TABLE IF NOT EXISTS rows (id TEXT PRIMARY KEY)')
const insert = db.prepare('INSERT INTO rows (id) VALUES (?)')

const bus = createBus()
await bus.subscribe('*', (e) => {
  appendFileSync(markerPath, `${e.type}\n`)
})
armChaos(bus)

for (const step of plan) {
  if (step.op === 'write') insert.run(step.id)
  else if (step.op === 'publish') await bus.publish(event(step.type))
  else if (step.op === 'batch') await bus.publishBatch(step.types.map(event))
  else if (step.op === 'exit') {
    db.close()
    process.exit(step.code)
  } else if (step.op === 'hang') {
    setInterval(() => {}, 1 << 30)
    await new Promise(() => {})
  } else throw new Error(`unknown op ${JSON.stringify(step)}`)
  console.log(`done ${step.op}`)
}
db.close()
