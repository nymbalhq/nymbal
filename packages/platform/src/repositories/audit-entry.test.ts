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
  actorId: fc.constantFrom('a1', 'a2', 'acp:a1'),
  command: fc.constantFrom(...COMMANDS),
  subject: fc.constantFrom('s1', 's2'),
  correlation: fc.constantFrom('k1', 'k2', null),
  outcome: fc.constantFrom(...OUTCOMES),
  status: fc.constantFrom(200, 409, null),
})

const query = fc.record(
  {
    actor: fc.constantFrom('admin', 'a1', 'customer:a2', 'admin:a1', 'acp:a1', 'system:acp:a1'),
    command: fc.constantFrom(...COMMANDS),
    subject: fc.constantFrom('s1', 's2'),
    correlation: fc.constantFrom('k1', 'k2'),
    outcome: fc.constantFrom(...OUTCOMES),
    since: fc.integer({ min: 0, max: 5 }),
    until: fc.integer({ min: 0, max: 6 }),
  },
  { requiredKeys: [] },
)

type Row = typeof entry extends fc.Arbitrary<infer T> ? T : never

const actorRow = (kind: AuditActor['kind'], actorId: Row['actorId'], minute: number): Row => ({
  minute,
  kind,
  actorId,
  command: COMMANDS[0]!,
  subject: 's1',
  correlation: null,
  outcome: OUTCOMES[0]!,
  status: 200,
})

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
    // Only a known kind before the first colon splits: an actor id may hold a colon itself.
    const colon = f.actor.indexOf(':')
    const head = colon > 0 ? f.actor.slice(0, colon) : ''
    const [kind, id] = KINDS.includes(head as AuditActor['kind'])
      ? [head, f.actor.slice(colon + 1)]
      : [undefined, undefined]
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
      {
        numRuns: 40,
        // An id with a colon in it, filtered alone and under its kind: the cursor sits on the first match, so a
        // listing that splits on an unknown kind returns nothing where the second match belongs.
        examples: [
          [
            [
              actorRow('system', 'acp:a1', 0),
              actorRow('system', 'acp:a1', 1),
              actorRow('admin', 'a1', 2),
            ],
            { actor: 'acp:a1' },
            'asc',
            6,
            0,
          ],
          [
            [
              actorRow('system', 'acp:a1', 0),
              actorRow('customer', 'acp:a1', 1),
              actorRow('system', 'acp:a1', 2),
            ],
            { actor: 'system:acp:a1' },
            'asc',
            6,
            0,
          ],
        ],
      },
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

function insert(
  id: string,
  minute: number,
  over: Partial<AuditEntryInsert> = {},
): AuditEntryInsert {
  return {
    id,
    at: new Date(T0 + minute * 60_000),
    actor: { kind: 'admin', id: 'a1' },
    command: 'order.refund',
    subjects: [{ type: 'order', id: 'o1' }],
    correlationId: null,
    idempotencyKey: null,
    requestHash: null,
    outcome: 'applied',
    responseStatus: 200,
    responseBody: undefined,
    ...over,
  }
}

/** What a listing answers for an appended entry: no request hash and never the stored body. */
const listedAs = (e: AuditEntryInsert) => ({
  id: e.id,
  at: e.at.toISOString(),
  actor: e.actor,
  command: e.command,
  subjects: e.subjects,
  correlationId: e.correlationId,
  idempotencyKey: e.idempotencyKey,
  outcome: e.outcome,
  responseStatus: e.responseStatus,
})

async function withEntries(entries: AuditEntryInsert[]) {
  const { store, repo } = await setup()
  await store.transaction(async (tx) => {
    for (const e of entries) await repo.append(tx, e)
  })
  return { store, repo }
}

describe('audit entries by id', () => {
  it('answers each named entry with its own actor, command, correlation and key, and nothing for no ids', async () => {
    const written = [
      insert('e1', 0, { correlationId: 'c1', idempotencyKey: 'k1', responseBody: { ok: 1 } }),
      insert('e2', 1, { actor: { kind: 'system', id: 'stripe' }, command: 'payment.capture' }),
      insert('e3', 2, {
        actor: { kind: 'customer', id: 'u7' },
        command: 'checkout.complete',
        correlationId: 'c3',
        idempotencyKey: 'k3',
        outcome: 'refused',
        responseStatus: 409,
      }),
    ]
    const { store, repo } = await withEntries(written)
    // Defect: the ids are ignored (every entry answers), or correlation and key read back as null.
    const found = await store.read((tx) => repo.byIds(tx, ['e3', 'e1', 'missing']))
    expect([...found].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [written[0]!, written[2]!].map(listedAs),
    )
    // Defect: no ids reads the table, or answers a placeholder.
    expect(await store.read((tx) => repo.byIds(tx, []))).toEqual([])
    await store.close()
  })
})

describe('the applied entry under a key', () => {
  it('is the applied one of that actor, command and key, with its hash, subjects, status and body', async () => {
    const subjects = [{ type: 'order', id: 'o9' }]
    const { store, repo } = await withEntries([
      // Same actor, command and key, but refused: never what a replay answers.
      insert('e0', 0, {
        idempotencyKey: 'k1',
        requestHash: 'h0',
        outcome: 'refused',
        responseStatus: 409,
      }),
      insert('e1', 1, {
        idempotencyKey: 'k1',
        requestHash: 'h1',
        subjects,
        responseStatus: 201,
        responseBody: { refundId: 'r1' },
      }),
      insert('e2', 2, {
        actor: { kind: 'admin', id: 'a2' },
        idempotencyKey: 'k1',
        responseBody: { refundId: 'r2' },
      }),
      insert('e3', 3, {
        command: 'order.cancel',
        idempotencyKey: 'k1',
        responseBody: { cancelled: true },
      }),
      insert('e4', 4, { idempotencyKey: 'k2', responseStatus: 204 }),
    ])
    const find = (actorId: string, command: string, key: string) =>
      store.read((tx) => repo.findAppliedByKey(tx, actorId, command, key))
    // Defect: the match is dropped or ignores the outcome, so the refused entry (or another's) is replayed; or the
    // hash or body read back as null.
    expect(await find('a1', 'order.refund', 'k1')).toEqual({
      requestHash: 'h1',
      subjects,
      responseStatus: 201,
      responseBody: { refundId: 'r1' },
    })
    // Defect: one actor's or command's stored answer replays for another's request under the same key.
    expect((await find('a2', 'order.refund', 'k1'))?.responseBody).toEqual({ refundId: 'r2' })
    expect((await find('a1', 'order.cancel', 'k1'))?.responseBody).toEqual({ cancelled: true })
    // Defect: an entry appended with no body reads back a body.
    expect(await find('a1', 'order.refund', 'k2')).toEqual({
      requestHash: null,
      subjects: [{ type: 'order', id: 'o1' }],
      responseStatus: 204,
      responseBody: null,
    })
    // Defect: an unused key answers an entry, or throws instead of answering none.
    expect(await find('a1', 'order.refund', 'k9')).toBeNull()
    await store.close()
  })
})

describe('audit listings', () => {
  it('newest first, a page from a cursor holds the entries older than it', async () => {
    const { store, repo } = await withEntries([0, 1, 2, 3].map((m) => insert(`e${m}`, m)))
    const list = (q: Omit<AuditQuery, 'order'>) =>
      store.read((tx) => repo.list(tx, { ...q, order: 'desc' }))
    const all = await list({ limit: 10 })
    // Defect: `desc` lists oldest first.
    expect(all.map((e) => e.id)).toEqual(['e3', 'e2', 'e1', 'e0'])
    const first = await list({ limit: 2 })
    const last = first[first.length - 1]!
    // Defect: a newest-first cursor reads the entries newer than it.
    const next = await list({ limit: 2, cursor: { at: last.at, id: last.id } })
    expect([...first, ...next]).toEqual(all)
    await store.close()
  })

  it('an outcome filter keeps only that outcome', async () => {
    const written = [
      insert('e0', 0),
      insert('e1', 1, { outcome: 'refused', responseStatus: 409 }),
      insert('e2', 2, { outcome: 'replayed' }),
    ]
    const { store, repo } = await withEntries(written)
    // Defect: the outcome filter is dropped and every entry answers.
    const refused = await store.read((tx) =>
      repo.list(tx, { outcome: 'refused', order: 'asc', limit: 10 }),
    )
    expect(refused).toEqual(written.filter((w) => w.outcome === 'refused').map(listedAs))
    await store.close()
  })

  it('an actor id with no colon that begins with a kind name is matched as an id, whatever its kind', async () => {
    const written = [
      insert('e0', 0, { actor: { kind: 'customer', id: 'admin1' } }),
      insert('e1', 1, { actor: { kind: 'admin', id: 'admin1' } }),
      insert('e2', 2, { actor: { kind: 'admin', id: 'a1' } }),
    ]
    const { store, repo } = await withEntries(written)
    // Defect: an id with no colon is split as if one ended its kind, so only the admin's entry answers.
    const byActor = await store.read((tx) =>
      repo.list(tx, { actor: 'admin1', order: 'asc', limit: 10 }),
    )
    expect(byActor).toEqual(written.filter((w) => w.actor.id === 'admin1').map(listedAs))
    await store.close()
  })
})
