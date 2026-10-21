import { eventRows, type EventRow } from './outbox.js'
import type { RawReader } from './raw.js'

// P3-01 support (spec P3-01-event-log-surface): the correlation id as a client sees it (the `x-correlation-id`
// response header, decision 2) and as the log holds it (each envelope's `correlationId`). Nothing here knows how the
// scope is implemented.

export const CORRELATION_HEADER = 'x-correlation-id'

/** Decision 3's pattern for an id the store accepts or echoes. */
export const DECISION_3 = /^[A-Za-z0-9._:-]{1,128}$/

/** A uuidv7, as the Fastify adapter's `genReqId` makes one. */
export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Decision 5's id for a run outside HTTP: `<origin>:<uuidv7>`. */
export function originId(origin: string): RegExp {
  return new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:${UUID_V7.source.slice(1)}`)
}

export interface Answer {
  status: number
  body: unknown
  /** The response's `x-correlation-id`, or null when it has none. */
  correlationId: string | null
}

/** One request to a running store, answering its status, parsed body and correlation header. */
export async function send(
  baseUrl: string,
  request: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Answer> {
  const res = await fetch(new URL(request.path, baseUrl), {
    method: request.method,
    ...(request.headers !== undefined && { headers: request.headers }),
    ...(request.body !== undefined && { body: request.body }),
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    // a plain-text or HTML answer stays as text
  }
  return { status: res.status, body, correlationId: res.headers.get(CORRELATION_HEADER) }
}

/** Every event row above `seq`, in seq order. */
export function eventsAfter(raw: RawReader, seq: number): Promise<EventRow[]> {
  return eventRows(raw, 'seq > ?', [seq])
}

export function correlationIdsOf(rows: EventRow[]): string[] {
  return rows.map((row) => row.envelope.correlationId)
}

export function payloadOf(row: EventRow): Record<string, unknown> {
  return (row.envelope.payload ?? {}) as Record<string, unknown>
}
