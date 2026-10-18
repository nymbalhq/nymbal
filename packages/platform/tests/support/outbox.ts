import type { EventBusAdapter, NymbalEvent } from '@nymbalhq/types'
import type { RawReader } from './raw.js'

// P1-03 support: the `events` table as a second connection sees it, and a bus whose publish rejects for chosen
// event types (the AC-6 / AC-9 wrapper; the relay looks `publish` up on the bus at call time).

export interface EventRow {
  seq: number
  id: string
  type: string
  envelope: NymbalEvent<unknown>
  deliveredAt: unknown
  attempts: number
  deadAt: unknown
}

interface RawEventRow {
  seq: number | string
  id: string
  type: string
  envelope: string | NymbalEvent<unknown>
  delivered_at: unknown
  attempts: number | string
  dead_at: unknown
}

/** `events` rows in `seq` order; SQLite keeps the envelope as JSON text, Postgres as jsonb. */
export async function eventRows(
  raw: RawReader,
  where?: string,
  params: unknown[] = [],
): Promise<EventRow[]> {
  const rows = await raw.rows<RawEventRow>(
    `SELECT seq, id, type, envelope, delivered_at, attempts, dead_at FROM events${
      where ? ` WHERE ${where}` : ''
    } ORDER BY seq`,
    params,
  )
  return rows.map((row) => ({
    seq: Number(row.seq),
    id: row.id,
    type: row.type,
    envelope:
      typeof row.envelope === 'string'
        ? (JSON.parse(row.envelope) as NymbalEvent<unknown>)
        : row.envelope,
    deliveredAt: row.delivered_at,
    attempts: Number(row.attempts),
    deadAt: row.dead_at,
  }))
}

/** The highest `seq` so far (0 for an empty log): rows a step appends are the ones above it. */
export async function maxSeq(raw: RawReader): Promise<number> {
  const [row] = await raw.rows<{ n: number | string | null }>('SELECT max(seq) AS n FROM events')
  return Number(row?.n ?? 0)
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ')
}

export interface FailingBus {
  /** Ids the wrapper rejected, one entry per attempt. */
  rejected: string[]
  restore(): void
}

/** Makes `bus.publish` reject for events of `types` until `restore()`; other events pass through. */
export function failPublishFor(bus: EventBusAdapter, types: string[]): FailingBus {
  const original = bus.publish
  const rejected: string[] = []
  bus.publish = async function <T>(this: EventBusAdapter, event: NymbalEvent<T>) {
    if (types.includes(event.type)) {
      rejected.push(event.id)
      throw new Error(`bus unavailable for ${event.type}`)
    }
    return original.call(bus, event)
  }
  return {
    rejected,
    restore() {
      bus.publish = original
    },
  }
}
