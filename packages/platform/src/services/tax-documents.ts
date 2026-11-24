import type { Logger, OrderRefund, TaxAdapter, TaxQuote } from '@nymbalhq/types'
import type { CommandStore } from '../db/command-store.js'
import type { Repositories } from '../repositories/index.js'
import type { OrderTaxDocument } from '../repositories/order-tax-document.js'
import { TAX_BOUND_MS } from './tax-quote.js'

/** `none`: nothing to file; `filed`: nothing left owed; `due`: a provider call failed and the record is owed. */
export type TaxFiling = 'none' | 'filed' | 'due'

export interface TaxDocuments {
  /** Files the order and its succeeded refunds with the tax provider, as far as each is still owed. */
  file(orderId: string): Promise<TaxFiling>
}

export interface TaxDocumentsDeps {
  store: CommandStore
  repos: Pick<Repositories, 'order' | 'orderRefund' | 'orderTaxDocument'>
  tax: TaxAdapter
  logger: Logger
  boundMs?: number
  now?: () => Date
}

/** Whether the adapter files transactions: it declares `commit` and has the method. */
export function filesTaxDocuments(tax: TaxAdapter): boolean {
  return tax.capabilities().includes('commit') && typeof tax.commit === 'function'
}

type Attempt<T> = { ok: true; value: T } | { ok: false; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Files paid orders with the provider that quoted them, and each succeeded refund once. No transaction is open across a
 * provider call, so a slow provider never holds the store's writes. A provider failure is recorded on the order's record
 * and answered as `due` (the sweep retries it); a store failure rejects. The conditional `commit` and `addRefund` keep
 * two filings of one order at once from doubling anything in the record.
 */
export function createTaxDocuments(deps: TaxDocumentsDeps): TaxDocuments {
  const { store, repos, tax, logger } = deps
  const boundMs = deps.boundMs ?? TAX_BOUND_MS
  const now = deps.now ?? (() => new Date())
  const records = repos.orderTaxDocument

  /** The provider's answer, abandoned at the bound. The call starts inside the chain, so a synchronous throw is caught. */
  async function attempt<T>(call: () => Promise<T>): Promise<Attempt<T>> {
    let timer: NodeJS.Timeout | undefined
    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`tax provider past the ${boundMs} ms bound`)),
        boundMs,
      )
    })
    try {
      return { ok: true, value: await Promise.race([Promise.resolve().then(call), bound]) }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  const find = (orderId: string) => store.read((tx) => records.find(tx, orderId))
  const markDue = (orderId: string) =>
    store.transaction((tx) => records.markDue(tx, orderId, now()))
  const failed = async (orderId: string, message: string): Promise<TaxFiling> => {
    await store.transaction((tx) => records.recordFailure(tx, orderId, message, now()))
    return 'due'
  }
  const filesRefunds = () =>
    tax.capabilities().includes('refund') && typeof tax.refund === 'function'
  const unfiled = (refunds: OrderRefund[], record: OrderTaxDocument) =>
    refunds.filter((r) => r.status === 'succeeded' && !record.filedRefundIds.includes(r.id))

  return {
    async file(orderId) {
      if (!filesTaxDocuments(tax)) return 'none'
      const order = await store.read((tx) => repos.order.findById(tx, orderId))
      if (order === null || order.status === 'cancelled' || order.capturedMinor <= 0) return 'none'
      const quote = order.metadata['tax']
      if (!isRecord(quote) || typeof quote['provider'] !== 'string' || quote['fallback'] === true) {
        return 'none'
      }
      if (quote['provider'] !== tax.providerName) {
        logger.warn(
          {
            orderId,
            orderNumber: order.orderNumber,
            quotedBy: quote['provider'],
            provider: tax.providerName,
          },
          `order ${order.orderNumber} was quoted by ${quote['provider']}, not ${tax.providerName}: it is not filed`,
        )
        return 'none'
      }

      await store.transaction((tx) =>
        records.insertPending(tx, { orderId, provider: tax.providerName, at: now() }),
      )
      let record = (await find(orderId))!
      if (record.status === 'pending') {
        await markDue(orderId)
        const ref = { orderId, orderNumber: order.orderNumber, currency: order.currency }
        const answer = await attempt(() => tax.commit!(quote as unknown as TaxQuote, ref))
        if (!answer.ok) return failed(orderId, answer.message)
        const documentId: unknown = answer.value?.documentId
        if (typeof documentId !== 'string' || documentId === '') {
          return failed(orderId, 'the tax provider answered no document id')
        }
        await store.transaction((tx) => records.commit(tx, orderId, documentId, now()))
        // Another filing may have committed first: its document is the one kept.
        record = (await find(orderId))!
      }

      if (filesRefunds()) {
        const refunds = await store.read((tx) => repos.orderRefund.listByOrder(tx, orderId))
        const doc = { provider: record.provider, documentId: record.documentId! }
        for (const refund of unfiled(refunds, record)) {
          await markDue(orderId)
          const answer = await attempt(() =>
            tax.refund!(doc, {
              refundId: refund.id,
              amountMinor: refund.amountMinor,
              currency: refund.currency,
            }),
          )
          if (!answer.ok) return failed(orderId, answer.message)
          await store.transaction((tx) =>
            records.addRefund(tx, orderId, refund.id, refund.amountMinor, now()),
          )
        }
      }

      // Cleared only when the record, read with the order's refunds in one transaction, owes nothing: a refund that
      // settled meanwhile, or whose filing another call failed and recorded, keeps it due. The record is locked so
      // such a failure cannot commit between the refunds read and the clear (Postgres runs READ COMMITTED).
      const settled = await store.transaction(async (tx) => {
        const current = (await records.lock(tx, orderId))!
        const owed = filesRefunds()
          ? unfiled(await repos.orderRefund.listByOrder(tx, orderId), current)
          : []
        if (owed.length > 0) {
          await records.markDue(tx, orderId, now())
          return false
        }
        await records.clear(tx, orderId, now())
        return true
      })
      return settled ? 'filed' : 'due'
    },
  }
}
