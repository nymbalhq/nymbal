import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineCommand } from 'citty'
import {
  createCommandStore,
  createEventLogRepository,
  sqliteFile,
  type CommandStore,
  type EventLogRepository,
  type LoggedEvent,
} from '@nymbalhq/platform'
import { errorText, isValidCorrelationId } from '@nymbalhq/types'
import { loadProject } from '../utils/project.js'

const POLL_MS = 500
const TAIL_PAGE = 1000

/** A bad flag or a missing store, said in the user's terms. */
class EventsError extends Error {}

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

/** The project's command store, opened read-only as `nymbal doctor` opens it: these commands never write. */
async function openLog(): Promise<{ store: CommandStore; eventLog: EventLogRepository }> {
  const { config } = await loadProject()
  if (config.infrastructure.commandStore === 'sqlite') {
    const path = sqliteFile()
    if (!existsSync(resolve(path))) {
      throw new EventsError(`no database at ${path}: run \`nymbal migrate\``)
    }
  }
  const store = createCommandStore(config, { readOnly: true })
  return { store, eventLog: createEventLogRepository(store) }
}

/** Runs `body`; any error it throws (a bad flag, no config, no store) is printed to stderr with exit code 2. */
async function guarded(body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    process.stderr.write(`nymbal events: ${errorText(error)}\n`)
    process.exitCode = 2
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

export const eventsCommand = defineCommand({
  meta: { name: 'events', description: 'Read the event log without changing it' },
  subCommands: { query: queryCommand, tail: tailCommand },
})
