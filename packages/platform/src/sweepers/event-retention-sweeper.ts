import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import type { Logger } from '@nymbalhq/types'
import type { CommandStore } from '../db/command-store.js'
import type { EventLogRepository, LoggedEvent } from '../repositories/event-log.js'
import type { ProcessedEventRepository } from '../repositories/processed-event.js'
import type { SweeperHandle } from './inventory-reservation-sweeper.js'

/** Where retention writes events before it deletes them: one object per batch, private to the operator. */
export interface EventArchiveWriter {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
}

export interface EventRetentionSweeperDeps {
  store: CommandStore
  eventLog: EventLogRepository
  processedEvents: ProcessedEventRepository
  logger: Logger
  retentionDays?: number
  intervalMs?: number
  /** When set, delivered events past retention are archived here first, and deleted only once the put succeeds. */
  archive?: EventArchiveWriter
}

const DAY_MS = 24 * 60 * 60 * 1000
const ARCHIVE_BATCH = 5000
const gzipAsync = promisify(gzip)

const pad = (n: number) => String(n).padStart(2, '0')

/** `events/<yyyy>/<mm>/<dd>/<firstSeq>-<lastSeq>.ndjson.gz`, dated in UTC by the first row's append. */
function archiveKey(batch: LoggedEvent[]): string {
  const first = batch[0]!
  const last = batch[batch.length - 1]!
  const at = first.createdAt
  const day = `${at.getUTCFullYear()}/${pad(at.getUTCMonth() + 1)}/${pad(at.getUTCDate())}`
  return `events/${day}/${first.seq}-${last.seq}.ndjson.gz`
}

/** One line per event: its envelope, with the log's `seq` and `deliveredAt`. */
function archiveBody(batch: LoggedEvent[]): Promise<Buffer> {
  const lines = batch.map(
    (row) => `${JSON.stringify({ ...row.event, seq: row.seq, deliveredAt: row.deliveredAt })}\n`,
  )
  return gzipAsync(lines.join(''))
}

/**
 * Deletes delivered events and processed-event records older than the window; undelivered and dead events stay. With
 * an archive, events go to it in `seq`-ordered batches first.
 */
export function startEventRetentionSweeper(deps: EventRetentionSweeperDeps): SweeperHandle {
  const retentionDays = deps.retentionDays ?? 30
  const intervalMs = deps.intervalMs ?? 3_600_000
  const logger = deps.logger.child({ sweeper: 'event-retention' })
  const { archive } = deps
  let running = false
  // The last seq of a batch whose put failed or whose delete did not follow. The next attempt ends there, so it writes
  // that key again rather than a wider batch overlapping it; the object may already exist, so readers dedupe by seq.
  let unconfirmedLastSeq: number | undefined

  /** Archives, then deletes, every delivered event past `cutoff`, batch by batch; a failed put stops the run. */
  async function archiveThenDelete(writer: EventArchiveWriter, cutoff: Date): Promise<number> {
    let deleted = 0
    for (;;) {
      const retry = unconfirmedLastSeq
      let batch = await deps.store.read((tx) =>
        deps.eventLog.listDeliveredBefore(tx, cutoff, ARCHIVE_BATCH),
      )
      if (retry !== undefined) batch = batch.filter((row) => row.seq <= retry)
      if (batch.length === 0) {
        // An unconfirmed batch's rows may have gone another way (another replica's sweep): nothing is pending then.
        unconfirmedLastSeq = undefined
        if (retry !== undefined) continue
        return deleted
      }
      unconfirmedLastSeq = batch[batch.length - 1]!.seq
      await writer.put(archiveKey(batch), await archiveBody(batch), 'application/gzip')
      const seqs = batch.map((row) => row.seq)
      deleted += await deps.store.transaction((tx) => deps.eventLog.deleteSeqs(tx, seqs))
      unconfirmedLastSeq = undefined
      if (retry === undefined && batch.length < ARCHIVE_BATCH) return deleted
    }
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const cutoff = new Date(Date.now() - retentionDays * DAY_MS)
      let deleted: { events: number; processed: number }
      if (archive === undefined) {
        deleted = await deps.store.transaction(async (tx) => ({
          events: await deps.eventLog.deleteDeliveredBefore(tx, cutoff),
          processed: await deps.processedEvents.deleteBefore(tx, cutoff),
        }))
      } else {
        const processed = await deps.store.transaction((tx) =>
          deps.processedEvents.deleteBefore(tx, cutoff),
        )
        deleted = { processed, events: await archiveThenDelete(archive, cutoff) }
      }
      if (deleted.events > 0 || deleted.processed > 0) {
        logger.info({ ...deleted, cutoff: cutoff.toISOString() }, 'deleted expired event records')
      }
    } catch (err) {
      logger.error({ err }, 'event retention sweep failed; undeleted events stay for the next run')
    } finally {
      running = false
    }
  }

  const handle = setInterval(() => void tick(), intervalMs)
  handle.unref()
  return {
    tick,
    stop() {
      clearInterval(handle)
    },
  }
}
