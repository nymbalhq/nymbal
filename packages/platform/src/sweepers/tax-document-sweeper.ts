import type { Logger } from '@nymbalhq/types'
import type { CommandStore } from '../db/command-store.js'
import { newCorrelationId, runWithCorrelation } from '../events/correlation.js'
import type { OrderTaxDocumentRepository } from '../repositories/order-tax-document.js'
import type { TaxDocuments } from '../services/tax-documents.js'
import type { SweeperHandle } from './inventory-reservation-sweeper.js'

const BATCH_LIMIT = 50

export interface TaxDocumentSweeperDeps {
  store: CommandStore
  repo: Pick<OrderTaxDocumentRepository, 'listDue'>
  documents: TaxDocuments
  /** The store's tax provider: another provider's records are never retried against it. */
  providerName: string
  logger: Logger
  intervalMs?: number
  /** How long a record has been due before a sweep takes it, so a filing that just failed is not tried again at once. */
  minAgeMs?: number
  now?: () => Date
}

/**
 * Retries what is owed to the tax provider: each record of the current provider due for at least `minAgeMs`, the least
 * recently tried first, so records the provider always refuses cannot hold the rest back. A tick during a tick waits
 * for it.
 */
export function startTaxDocumentSweeper(deps: TaxDocumentSweeperDeps): SweeperHandle {
  const { store, repo, documents, providerName } = deps
  const intervalMs = deps.intervalMs ?? 300_000
  const minAgeMs = deps.minAgeMs ?? 60_000
  const now = deps.now ?? (() => new Date())
  const logger = deps.logger.child({ sweeper: 'tax-documents' })

  async function tick(): Promise<void> {
    try {
      const before = new Date(now().getTime() - minAgeMs)
      const due = await store.read((tx) =>
        repo.listDue(tx, { provider: providerName, before, limit: BATCH_LIMIT }),
      )
      for (const { orderId } of due) {
        await documents.file(orderId).catch((err: unknown) => {
          logger.error({ err, orderId }, 'failed to file the order with the tax provider')
        })
      }
    } catch (err) {
      logger.error({ err }, 'tax document sweep failed; what is owed stays for the next run')
    }
  }

  let inFlight: Promise<void> | undefined
  const run = (): Promise<void> => {
    inFlight ??= runWithCorrelation(newCorrelationId('sweep:tax-documents'), tick).finally(() => {
      inFlight = undefined
    })
    return inFlight
  }
  const handle = setInterval(() => void run(), intervalMs)
  handle.unref()
  return {
    tick: run,
    stop() {
      clearInterval(handle)
    },
  }
}
