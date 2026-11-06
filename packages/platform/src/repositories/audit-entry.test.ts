import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { AuditActor, AuditOutcome } from '@nymbalhq/types'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import {
  auditEntriesInOrder,
  createAuditEntryRepository,
  type AuditEntryInsert,
  type AuditQuery,
} from './audit-entry.js'

// The audit log reads back what was appended, filtered and ordered as asked: a listing equals the entries a plain
// filter over what was written keeps, in (at, id) order, from the cursor on, cut at the limit; and the export's paged
// walk yields every matching entry once, oldest first, whatever the page size.

async function setup() {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  return { store, repo: createAuditEntryRepository(store) }
}

const T0 = Date.parse('2026-11-01T00:00:00.000Z')
const KINDS: AuditActor['kind'][] = ['admin', 'customer', 'system']
const COMMANDS = ['product.update', 'order.refund']
const OUTCOMES: AuditOutcome[] = ['applied', 'refused']

const entry = fc.record({
  minute: fc.integer({ min: 0, max: 5 }),
  kind: fc.constantFrom(...KINDS),
  actorId: fc.constantFrom('a1', 'a2'),
  command: fc.constantFrom(...COMMANDS),
  subject: fc.constantFrom('s1', 's2'),
  correlation: fc.constantFrom('k1', 'k2', null),
  outcome: fc.constantFrom(...OUTCOMES),
  status: fc.constantFrom(200, 409, null),
})

const query = fc.record(
  {
    actor: fc.constantFrom('admin', 'a1', 'customer:a2', 'admin:a1'),
    command: fc.constantFrom(...COMMANDS),
    subject: fc.constantFrom('s1', 's2'),
    correlation: fc.constantFrom('k1', 'k2'),
    outcome: fc.constantFrom(...OUTCOMES),
    since: fc.integer({ min: 0, max: 5 }),
    until: fc.integer({ min: 0, max: 6 }),
  },
  { requiredKeys: [] },
)

type Written = AuditEntryInsert & { atIso: string }

type Filter = {
  actor?: string
  command?: string
  subject?: string
  correlation?: string
  outcome?: AuditOutcome
  since?: number
  until?: number
}

function matches(e: Written, f: Filter): boolean {
  if (f.actor !== undefined) {
    const [kind, id] = f.actor.includes(':') ? f.actor.split(':') : [undefined, undefined]
    const ok =
      kind !== undefined
        ? e.actor.kind === kind && e.actor.id === id
        : KINDS.includes(f.actor as AuditActor['kind'])
          ? e.actor.kind === f.actor
          : e.actor.id === f.actor
    if (!ok) return false
  }
  if (f.command !== undefined && e.command !== f.command) return false
  if (f.subject !== undefined && !e.subjects.some((s) => s.id === f.subject)) return false
  if (f.correlation !== undefined && e.correlationId !== f.correlation) return false
  if (f.outcome !== undefined && e.outcome !== f.outcome) return false
  if (f.since !== undefined && e.at.getTime() < T0 + f.since * 60_000) return false
  if (f.until !== undefined && e.at.getTime() >= T0 + f.until * 60_000) return false
  return true
}

const byAtId = (a: Written, b: Written): number =>
  a.atIso === b.atIso ? a.id.localeCompare(b.id) : a.atIso.localeCompare(b.atIso)

describe('audit entries', () => {
  it('property: a listing is the model’s filter of what was written, in order, from the cursor, cut at the limit', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(entry, { minLength: 1, maxLength: 12 }),
        query,
        fc.constantFrom('asc' as const, 'desc' as const),
        fc.integer({ min: 1, max: 6 }),
        fc.nat(),
        async (rows, q, order, limit, cursorAt) => {
          const { store, repo } = await setup()
          const written: Written[] = rows.map((r, i) => {
            const at = new Date(T0 + r.minute * 60_000)
            return {
              id: `e${String(i).padStart(2, '0')}`,
              at,
              atIso: at.toISOString(),
              actor: { kind: r.kind, id: r.actorId },
              command: r.command,
              subjects: [{ type: 'product', id: r.subject }],
              correlationId: r.correlation,
              idempotencyKey: null,
              requestHash: null,
              outcome: r.outcome,
              responseStatus: r.status,
              responseBody: undefined,
            }
          })
          await store.transaction(async (tx) => {
            for (const w of written) await repo.append(tx, w)
          })
          const sorted = written.filter((w) => matches(w, q)).sort(byAtId)
          if (order === 'desc') sorted.reverse()
          // A cursor at one of the written entries, when any matches.
          const at = sorted.length === 0 ? undefined : sorted[cursorAt % sorted.length]!
          const cursor = at === undefined ? undefined : { at: at.atIso, id: at.id }
          const expected = (cursor === undefined ? sorted : sorted.slice(sorted.indexOf(at!) + 1))
            .slice(0, limit)
            .map((w) => ({
              id: w.id,
              at: w.atIso,
              actor: w.actor,
              command: w.command,
              subjects: w.subjects,
              correlationId: w.correlationId,
              idempotencyKey: null,
              outcome: w.outcome,
              responseStatus: w.responseStatus,
            }))
          const full: AuditQuery = {
            ...(q.actor !== undefined && { actor: q.actor }),
            ...(q.command !== undefined && { command: q.command }),
            ...(q.subject !== undefined && { subject: q.subject }),
            ...(q.correlation !== undefined && { correlation: q.correlation }),
            ...(q.outcome !== undefined && { outcome: q.outcome }),
            ...(q.since !== undefined && { since: new Date(T0 + q.since * 60_000) }),
            ...(q.until !== undefined && { until: new Date(T0 + q.until * 60_000) }),
            order,
            limit,
            ...(cursor !== undefined && { cursor }),
          }
          const listed = await store.read((tx) => repo.list(tx, full))
          expect(listed).toEqual(expected)
          await store.close()
        },
      ),
      { numRuns: 40 },
    )
  })

  it('pages through every matching entry once, oldest first, for any page size', async () => {
    const { store, repo } = await setup()
    const written = Array.from({ length: 7 }, (_, i) => ({
      id: `e${i}`,
      at: new Date(T0 + (i % 3) * 60_000),
      actor: { kind: 'admin' as const, id: 'a1' },
      command: i % 2 === 0 ? 'product.update' : 'order.refund',
      subjects: [{ type: 'product', id: 's1' }],
      correlationId: null,
      idempotencyKey: null,
      requestHash: null,
      outcome: 'applied' as const,
      responseStatus: 200,
      responseBody: undefined,
    }))
    await store.transaction(async (tx) => {
      for (const w of written) await repo.append(tx, w)
    })
    const oldestFirst = written
      .filter((w) => w.command === 'product.update')
      .sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id))
      .map((w) => w.id)
    for (const pageSize of [1, 2, 3, 4, 10]) {
      const walked: string[] = []
      for await (const e of auditEntriesInOrder(store, { command: 'product.update' }, pageSize)) {
        walked.push(e.id)
      }
      expect(walked, `page size ${pageSize}`).toEqual(oldestFirst)
    }
    await store.close()
  })
})
