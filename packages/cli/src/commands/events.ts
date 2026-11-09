import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineCommand } from 'citty'
import {
  createCommandStore,
  createEventLogRepository,
  sqliteFile,
  retryFloor,
  type CommandStore,
  type DeadEventSelection,
  type EventLogRepository,
  type LoggedEvent,
} from '@nymbalhq/platform'
import { errorText, isValidCorrelationId } from '@nymbalhq/types'
import { loadProject } from '../utils/project.js'

const POLL_MS = 500
const TAIL_PAGE = 1000
/** A delivery pass is serial and every command waits on it, so a run puts back at most this many (the relay's page). */
const RETRY_BATCH = 100
const LISTED_DEAD = 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A bad flag or a missing store, said in the user's terms: exit 2, or 1 when there was nothing to act on. */
class EventsError extends Error {
  exitCode: number
  constructor(message: string, exitCode = 2) {
    super(message)
    this.exitCode = exitCode
  }
}

/** One line per event: `<seq> <timestamp> <type> <correlationId> <id>`, or its envelope as JSON. */
function formatEvent(row: LoggedEvent, opts: { json: boolean; payload: boolean }): string {
  const { event } = row
  if (!opts.json) {
    // Events from before inbound ids were validated may carry any string: quoted, it cannot break the line.
    const correlationId = isValidCorrelationId(event.correlationId)
      ? event.correlationId
      : JSON.stringify(event.correlationId)
    return `${row.seq} ${event.timestamp} ${event.type} ${correlationId} ${event.id}`
  }
  // Payloads hold customer data: printed only when asked for.
  const { payload, ...envelope } = event
  return JSON.stringify({
    ...envelope,
    ...(opts.payload && { payload }),
    seq: row.seq,
    deliveredAt: row.deliveredAt,
    attempts: row.attempts,
    deadAt: row.deadAt,
  })
}

function timeFlag(name: string, value: string | undefined): Date | undefined {
  if (value === undefined) return undefined
  const at = new Date(value)
  if (value.trim() === '' || Number.isNaN(at.getTime())) {
    throw new EventsError(`--${name} must be an ISO 8601 time, got "${value}"`)
  }
  return at
}

function countFlag(name: string, value: string | undefined, min: number): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (value.trim() === '' || !Number.isInteger(n) || n < min) {
    throw new EventsError(`--${name} must be a whole number of at least ${min}, got "${value}"`)
  }
  return n
}

function typesFlag(value: string | undefined): { types?: string[] } {
  if (value === undefined) return {}
  if (value.trim() === '') throw new EventsError('--type must not be empty')
  return { types: [value] }
}

/** The project's command store, opened read-only as `nymbal doctor` opens it unless the command must write. */
async function openLog(writable = false): Promise<{
  store: CommandStore
  eventLog: EventLogRepository
  retentionDays: number
}> {
  const { config } = await loadProject()
  if (config.infrastructure.commandStore === 'sqlite') {
    const path = sqliteFile()
    if (!existsSync(resolve(path))) {
      throw new EventsError(`no database at ${path}: run \`nymbal migrate\``)
    }
  }
  const store = createCommandStore(config, { readOnly: !writable })
  return {
    store,
    eventLog: createEventLogRepository(store),
    retentionDays: config.events.retentionDays,
  }
}

/** Runs `body`; any error it throws (a bad flag, no config, no store) is printed to stderr with exit code 2. */
async function guarded(body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    process.stderr.write(`nymbal events: ${errorText(error)}\n`)
    process.exitCode = error instanceof EventsError ? error.exitCode : 2
  }
}

function write(lines: string[]): Promise<void> {
  if (lines.length === 0) return Promise.resolve()
  return new Promise((done) => process.stdout.write(`${lines.join('\n')}\n`, () => done()))
}

const outputArgs = {
  json: {
    type: 'boolean',
    description: 'One envelope per line, with seq and deliveredAt',
    default: false,
  },
  payload: {
    type: 'boolean',
    description: 'Include each event’s payload (it may hold customer data)',
    default: false,
  },
} as const

const queryCommand = defineCommand({
  meta: { name: 'query', description: 'Print one correlation id’s events, in seq order' },
  args: {
    correlation: { type: 'string', description: 'The correlation id (required)' },
    type: {
      type: 'string',
      description: 'Only types matching this glob; * matches anything (order.*)',
    },
    since: { type: 'string', description: 'Only events appended at or after this ISO time' },
    until: { type: 'string', description: 'Only events appended before this ISO time' },
    limit: { type: 'string', description: 'At most this many events (default 1000)' },
    ...outputArgs,
  },
  run: ({ args }) =>
    guarded(async () => {
      const correlationId = args.correlation
      if (correlationId === undefined || correlationId === '') {
        throw new EventsError('--correlation <id> is required')
      }
      const since = timeFlag('since', args.since)
      const until = timeFlag('until', args.until)
      const filter = {
        ...typesFlag(args.type),
        ...(since !== undefined && { since }),
        ...(until !== undefined && { until }),
        limit: countFlag('limit', args.limit, 1) ?? 1000,
      }
      const { store, eventLog } = await openLog()
      try {
        const rows = await store.read((tx) =>
          eventLog.queryByCorrelation(tx, correlationId, filter),
        )
        await write(rows.map((row) => formatEvent(row, args)))
      } finally {
        await store.close()
      }
    }),
})

const tailCommand = defineCommand({
  meta: {
    name: 'tail',
    description:
      'Print events as they are appended, until interrupted. Exact for serially committed events; on Postgres an ' +
      'event whose lower seq commits after a higher one has been printed is skipped.',
  },
  args: {
    type: {
      type: 'string',
      description: 'Only types matching this glob; * matches anything (order.*)',
    },
    from: {
      type: 'string',
      description: 'Print events above this seq (default: the current maximum)',
    },
    ...outputArgs,
  },
  run: ({ args }) =>
    guarded(async () => {
      const types = typesFlag(args.type)
      const from = countFlag('from', args.from, 0)
      const { store, eventLog } = await openLog()
      let stopped = false
      let wake: (() => void) | undefined
      const stop = () => {
        stopped = true
        wake?.()
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      try {
        let cursor = from ?? (await store.read((tx) => eventLog.maxSeq(tx)))
        process.stderr.write(`tailing from seq ${cursor}\n`)
        while (!stopped) {
          const after = cursor
          const rows = await store.read((tx) =>
            eventLog.listAfter(tx, after, { ...types, limit: TAIL_PAGE }),
          )
          await write(rows.map((row) => formatEvent(row, args)))
          if (rows.length > 0) cursor = rows[rows.length - 1]!.seq
          // A full page means more is waiting: read it now.
          if (rows.length === TAIL_PAGE) continue
          await new Promise<void>((done) => {
            const timer = setTimeout(done, POLL_MS)
            wake = () => {
              clearTimeout(timer)
              done()
            }
          })
          wake = undefined
        }
      } finally {
        process.off('SIGINT', stop)
        process.off('SIGTERM', stop)
        await store.close()
      }
    }),
})

type RetryTarget =
  | { kind: 'bare' | 'all' | 'filter'; selection: DeadEventSelection }
  | { kind: 'one'; selection: DeadEventSelection; label: string }

function retryTarget(args: {
  target?: string | undefined
  all: boolean
  type?: string | undefined
  since?: string | undefined
  until?: string | undefined
}): RetryTarget {
  const filtered = args.type !== undefined || args.since !== undefined || args.until !== undefined
  if (args.all && (args.target !== undefined || filtered)) {
    throw new EventsError('--all takes no seq, event id or filter')
  }
  if (args.target !== undefined) {
    if (filtered) throw new EventsError('a seq or event id takes no --type, --since or --until')
    const label = args.target
    if (UUID.test(label)) return { kind: 'one', selection: { id: label }, label }
    const seq = Number(label)
    if (!/^\d+$/.test(label) || seq < 1 || !Number.isSafeInteger(seq)) {
      throw new EventsError(`expected a seq (a whole number of at least 1) or an event id, got "${label}"`)
    }
    return { kind: 'one', selection: { seq }, label }
  }
  const since = timeFlag('since', args.since)
  const until = timeFlag('until', args.until)
  const selection = {
    ...typesFlag(args.type),
    ...(since !== undefined && { since }),
    ...(until !== undefined && { until }),
  }
  return { kind: filtered ? 'filter' : args.all ? 'all' : 'bare', selection }
}

/** The selection narrowed to what the retention floor lets a retry take. */
function retryableOf(selection: DeadEventSelection, floor: Date): DeadEventSelection {
  const { since } = selection
  return { ...selection, since: since === undefined || since < floor ? floor : since }
}

const PAST_RETENTION_WHY =
  'their delivery records are gone, so a retry could repeat side effects; left dead'

const retentionLines = (past: number, retentionDays: number): string[] =>
  past > 0
    ? [`${past} past retention (events.retentionDays ${retentionDays}): ${PAST_RETENTION_WHY}`]
    : []

const moreLines = (more: number): string[] =>
  more > 0 ? [`${more} more selected: run it again for the next ${RETRY_BATCH}`] : []

/** The dead rows' lines, oldest first, the rows the listing does not show counted. */
function deadListing(rows: LoggedEvent[], total: number, floor: Date): string[] {
  const lines = rows.map((row) => {
    const text = formatEvent(row, { json: false, payload: false })
    const past = row.createdAt < floor ? ' past-retention' : ''
    return `${text} dead ${row.deadAt!.toISOString()}${past}`
  })
  return total > rows.length ? [...lines, `and ${total - rows.length} more`] : lines
}

const retryCommand = defineCommand({
  meta: {
    name: 'retry',
    description:
      'List dead events, or put them back for the running store to deliver. Bare it lists and writes nothing.',
  },
  args: {
    target: { type: 'positional', required: false, description: 'One event, by seq or id' },
    all: { type: 'boolean', description: 'Every dead event, at most 100 a run', default: false },
    type: {
      type: 'string',
      description: 'Only types matching this glob; * matches anything (order.*)',
    },
    since: { type: 'string', description: 'Only events appended at or after this ISO time' },
    until: { type: 'string', description: 'Only events appended before this ISO time' },
    'dry-run': {
      type: 'boolean',
      description: 'Say what a retry would do and write nothing',
      default: false,
    },
  },
  run: ({ args }) =>
    guarded(async () => {
      const target = retryTarget(args)
      const { selection } = target
      const dryRun = args['dry-run']
      // Decided on a read-only open: a writable SQLite open changes the file even when nothing is retried.
      const reader = await openLog()
      const { retentionDays } = reader
      const floor = retryFloor(new Date(), retentionDays)
      const retryable = retryableOf(selection, floor)
      let found
      try {
        found = await reader.store.read(async (tx) => ({
          dead: await reader.eventLog.countDead(tx),
          selected: await reader.eventLog.countDead(tx, selection),
          retryable: await reader.eventLog.countDead(tx, retryable),
          rows: await reader.eventLog.listDead(tx, LISTED_DEAD, selection),
          exists:
            target.kind === 'one' ? await reader.eventLog.hasEvent(tx, selection) : false,
        }))
      } finally {
        await reader.store.close()
      }
      const { dead, selected, rows, exists } = found
      const past = selected - found.retryable

      if (target.kind === 'bare') {
        if (dead === 0) return write(['none dead'])
        return write([
          ...deadListing(rows, dead, floor),
          `${dead} dead: nymbal events retry --all retries them, nymbal events retry <seq> one`,
          ...retentionLines(past, retentionDays),
        ])
      }
      if (selected === 0) {
        if (target.kind === 'all') return write(['none dead'])
        if (target.kind !== 'one') throw new EventsError(`no dead event matches; ${dead} dead`, 1)
        throw new EventsError(
          exists
            ? `event ${target.label} is not dead; ${dead} dead`
            : `no event ${target.label}; ${dead} dead`,
          1,
        )
      }
      if (found.retryable === 0) {
        throw new EventsError(
          `${selected} selected past retention (events.retentionDays ${retentionDays}): ${PAST_RETENTION_WHY}`,
          1,
        )
      }
      if (dryRun) {
        return write([
          ...deadListing(rows, selected, floor),
          `would retry ${Math.min(found.retryable, RETRY_BATCH)} (dry run, nothing written)`,
          ...moreLines(found.retryable - RETRY_BATCH),
          ...retentionLines(past, retentionDays),
        ])
      }

      const writer = await openLog(true)
      try {
        const done = await writer.store.transaction(async (tx) => {
          const retried = await writer.eventLog.retryDead(tx, selection, {
            floor,
            limit: RETRY_BATCH,
          })
          const more = await writer.eventLog.countDead(tx, retryable)
          return {
            retried,
            more,
            stillDead: await writer.eventLog.countDead(tx),
            left: (await writer.eventLog.countDead(tx, selection)) - more,
          }
        })
        const delivered = done.retried.filter((row) => row.deliveredAt !== null).length
        await write([
          ...done.retried.map((row) => formatEvent(row, { json: false, payload: false })),
          `retried ${done.retried.length}; ${done.stillDead} still dead`,
          'the running store delivers them on its next pass, or at its next start; if the cause is not fixed they die again and nymbal doctor names them',
          ...(delivered > 0 ? [`${delivered} already delivered: cleared, not sent again`] : []),
          ...moreLines(done.more),
          ...retentionLines(done.left, retentionDays),
        ])
      } finally {
        await writer.store.close()
      }
    }),
})

export const eventsCommand = defineCommand({
  meta: {
    name: 'events',
    description: 'Read the event log, and put dead events back for the running store to deliver',
  },
  subCommands: { query: queryCommand, tail: tailCommand, retry: retryCommand },
})
