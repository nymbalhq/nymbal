import Database from 'better-sqlite3'
import pg from 'pg'
import type { NymbalConfig } from '@nymbalhq/config'
import type { CreateAppOptions } from '../../src/app.js'
import { CORRELATION_HEADER } from './correlation.js'
import type { Dialect } from './kernel.js'
import { eventRows, type EventRow } from './outbox.js'
import type { RawReader } from './raw.js'
import type { SignedDelivery } from './test-hooks.js'

// Deliveries to `POST /api/webhooks/<name>` as a provider sends them, and what they leave behind, read through a
// second connection: the processed-delivery records and the `events` rows.

export interface Delivered {
  status: number
  data?: Record<string, unknown>
  error?: { code: string; message: string }
  /** The whole parsed answer, for comparing two answers. */
  body: unknown
  correlationId: string | null
}

/** One delivery of `delivery`'s exact bytes and headers to the webhook named `name`. */
export async function postDelivery(
  baseUrl: string,
  name: string,
  delivery: SignedDelivery,
): Promise<Delivered> {
  const headers: Record<string, string> = {}
  const given: Record<string, string | string[] | undefined> = delivery.headers
  for (const [key, value] of Object.entries(given)) {
    if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value
  }
  const res = await fetch(new URL(`/api/webhooks/${encodeURIComponent(name)}`, baseUrl), {
    method: 'POST',
    headers,
    body: new Uint8Array(delivery.rawBody),
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    // a plain-text answer stays as text
  }
  const envelope = (typeof body === 'object' && body !== null ? body : {}) as Omit<
    Delivered,
    'status' | 'body' | 'correlationId'
  >
  return {
    status: res.status,
    ...(envelope.data !== undefined && { data: envelope.data }),
    ...(envelope.error !== undefined && { error: envelope.error }),
    body,
    correlationId: res.headers.get(CORRELATION_HEADER),
  }
}

/** How many processed-delivery records `handler` holds for `id`: 0 or 1. */
export function recordsFor(raw: RawReader, handler: string, id: string): Promise<number> {
  return raw.count('processed_events', 'handler_name = ? AND event_id = ?', [handler, id])
}

/** The committed log rows whose payload carries `parcelId`: one delivery's events, in seq order. */
export async function eventsOfParcel(raw: RawReader, parcelId: string): Promise<EventRow[]> {
  const rows = await eventRows(raw)
  return rows.filter(
    (row) => (row.envelope.payload as { parcelId?: unknown } | null)?.parcelId === parcelId,
  )
}

/** A processed-delivery record written straight into the table, as a route of an earlier version wrote it. */
export async function insertRecord(
  dialect: Dialect,
  target: string,
  handler: string,
  id: string,
): Promise<void> {
  if (dialect === 'sqlite') {
    const db = new Database(target, { fileMustExist: true })
    try {
      db.prepare(
        'INSERT INTO processed_events (handler_name, event_id, processed_at) VALUES (?, ?, ?)',
      ).run(handler, id, new Date().toISOString())
    } finally {
      db.close()
    }
    return
  }
  const client = new pg.Client({ connectionString: target })
  await client.connect()
  try {
    await client.query(
      'INSERT INTO processed_events (handler_name, event_id, processed_at) VALUES ($1, $2, now())',
      [handler, id],
    )
  } finally {
    await client.end()
  }
}

type Slot = keyof NymbalConfig['commerce']

/** The kernel config with each of `slots` set to `custom`, for the adapters a test injects there. */
export function customSlots(...slots: Slot[]): (config: NymbalConfig) => NymbalConfig {
  return (config) => ({
    ...config,
    commerce: {
      ...config.commerce,
      ...Object.fromEntries(slots.map((slot) => [slot, { provider: 'custom' }])),
    },
  })
}

export type InjectedAdapters = NonNullable<CreateAppOptions['adapters']>
