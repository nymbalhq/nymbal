import fc from 'fast-check'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  EVT_PROPOSAL_APPLIED,
  EVT_PROPOSAL_FAILED,
  type Logger,
  type RequestAuth,
} from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore, rawClients, type CommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { createEventPublisher, createRelay } from '../index.js'
import { createLogger } from '../logger.js'
import { buildRepositories } from '../repositories/index.js'
import type { ProposalRecord, ProposalRepository } from '../repositories/proposal.js'
import * as sweepers from '../sweepers/index.js'
import { wirePublisher } from '../tests/publisher.js'
import type { EventPublisher } from '../events/publisher.js'
import { createProposalService } from './proposal-service.js'

// The live settle and a sweep race for one approved row: the conditional settle has one winner, and only the winner
// publishes. The route is a stub `execute`; the store, the repositories and the publisher are real, on SQLite in memory.

const ADMIN: RequestAuth = { userId: 'admin-1', roles: ['admin'] }
const INTERRUPTED_CODE = 'proposal.interrupted'
const INTERRUPTED_TEXT =
  'The server stopped and this did not go through. Nothing was changed; ask the agent again if you still want it.'

async function harness() {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  const logger = createLogger({ pretty: false, level: 'error' })
  const publisher = wirePublisher(
    { createEventPublisher, createRelay },
    { store, eventLog: repos.eventLog, eventBus: new InProcessEventBus({ logger }), logger },
  ).publisher
  return { store, proposals: repos.proposal, publisher, logger }
}
type Harness = Awaited<ReturnType<typeof harness>>

async function pendingRow(h: Harness): Promise<string> {
  const id = randomUUID()
  await h.store.transaction((tx) =>
    h.proposals.insert(tx, {
      id,
      tool: 'admin_products_update',
      command: 'product.update',
      args: {},
      handles: null,
      idempotencyKey: null,
      proposerId: 'agent-admin',
      agentName: 'unit-agent',
      agentVersion: null,
      correlationId: randomUUID(),
      createdAt: new Date(),
    }),
  )
  return id
}

function settledEvents(store: CommandStore, proposalId: string): string[] {
  const clients = rawClients(store)
  if (clients.kind !== 'sqlite') throw new Error('this suite runs on SQLite')
  const rows = clients.raw
    .prepare('SELECT type, envelope FROM events WHERE type IN (?, ?) ORDER BY seq')
    .all(EVT_PROPOSAL_APPLIED, EVT_PROPOSAL_FAILED) as Array<{ type: string; envelope: string }>
  return rows
    .filter((row) => (JSON.parse(row.envelope) as { payload: { proposalId: string } }).payload.proposalId === proposalId)
    .map((row) => row.type)
}

/** What a sweep does to a row it wins: the conditional settle, then its event. */
function settleAsSweep(h: Harness, row: ProposalRecord): Promise<void> {
  const outcome = { status: 500, code: INTERRUPTED_CODE, message: INTERRUPTED_TEXT }
  return h.store.transaction(async (tx) => {
    if (!(await h.proposals.settle(tx, row.id, { status: 'failed', outcome, at: new Date() }))) {
      return
    }
    await h.publisher.correlated(row.correlationId).publish(EVT_PROPOSAL_FAILED, {
      proposalId: row.id,
      tool: row.tool,
      command: row.command,
      proposerId: row.proposerId,
      agentName: row.agentName,
      outcome,
    })
  })
}

interface StuckSweeperDeps {
  store: CommandStore
  proposals: ProposalRepository
  publisher: EventPublisher
  logger: Logger
  intervalMs?: number
  stuckAfterMs?: number
  now?: () => Date
}

const startSweeper = (
  sweepers as unknown as {
    startStuckProposalSweeper?: (deps: StuckSweeperDeps) => sweepers.SweeperHandle
  }
).startStuckProposalSweeper

function recordingLogger() {
  const entries: { level: string; args: unknown[] }[] = []
  const logger = Object.fromEntries(
    ['trace', 'debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args: unknown[]) => void entries.push({ level, args }),
    ]),
  ) as unknown as Logger
  return { logger, entries }
}

describe('createProposalService: a sweep and a live settle', () => {
  it('AC-9: property: one settled event in either order, and a live settle that loses to a sweep during execute leaves the swept row and answers it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(200, 201, 422, 500),
        fc.constantFrom('approve', 'run'),
        async (routeStatus, path) => {
          const h = await harness()
          try {
            // A sweep lands while the route runs: the live settle comes second and must lose quietly.
            const id = await pendingRow(h)
            const losing = recordingLogger()
            const service = createProposalService({
              store: h.store,
              proposals: h.proposals,
              publisher: h.publisher,
              logger: losing.logger,
              execute: async (row) => {
                await settleAsSweep(h, row)
                return { result: {} as never, outcome: { status: routeStatus } }
              },
            } as Parameters<typeof createProposalService>[0])

            const view =
              path === 'approve'
                ? await service.approve(id, ADMIN)
                : (await service.run(id, { kind: 'policy', rule: 'agents.autoApprove' }, ADMIN), await service.get(id))

            const stored = await h.store.read((tx) => h.proposals.findById(tx, id))
            expect(settledEvents(h.store, id)).toEqual([EVT_PROPOSAL_FAILED])
            expect(stored!.status).toBe('failed')
            expect(stored!.outcomeCode).toBe(INTERRUPTED_CODE)
            expect(view!.status).toBe(stored!.status)
            expect(view!.outcome?.code).toBe(INTERRUPTED_CODE)
            expect(losing.entries).toEqual([
              {
                level: 'warn',
                args: [{ proposalId: id, outcome: { status: routeStatus } }, expect.stringMatching(/not recorded/)],
              },
            ])

            // The other order: the live settle wins and a sweep holding a stale read of the row publishes nothing.
            const liveFirst = await pendingRow(h)
            const winning = recordingLogger()
            const live = createProposalService({
              store: h.store,
              proposals: h.proposals,
              publisher: h.publisher,
              logger: winning.logger,
              execute: async () => ({ result: {} as never, outcome: { status: 200 } }),
            } as Parameters<typeof createProposalService>[0])
            await live.approve(liveFirst, ADMIN)
            expect(winning.entries).toEqual([])
            const settled = await h.store.read((tx) => h.proposals.findById(tx, liveFirst))
            const staleSweep = startSweeper?.({
              store: h.store,
              proposals: {
                ...h.proposals,
                listStuck: async () => [{ ...settled!, status: 'approved' }],
              } as ProposalRepository,
              publisher: h.publisher,
              logger: h.logger,
              intervalMs: 3_600_000,
              stuckAfterMs: 1,
              now: () => new Date(Date.now() + 3_600_000),
            })
            try {
              await staleSweep?.tick()
            } finally {
              staleSweep?.stop()
            }
            expect(settledEvents(h.store, liveFirst)).toEqual([EVT_PROPOSAL_APPLIED])
            expect((await h.store.read((tx) => h.proposals.findById(tx, liveFirst)))!.status).toBe('applied')
          } finally {
            await h.store.close()
          }
        },
      ),
      { numRuns: 6 },
    )
  })
})
