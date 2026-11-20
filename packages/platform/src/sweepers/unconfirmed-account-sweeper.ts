import { EVT_CUSTOMER_DELETED, type Logger } from '@nymbalhq/types'
import type { CommandStore } from '../db/command-store.js'
import type { Repositories } from '../repositories/index.js'
import type { EventPublisher } from '../events/publisher.js'
import { newCorrelationId, runWithCorrelation } from '../events/correlation.js'
import { runAsActor } from '../audit/actor.js'
import { audit, auditedCommand } from '../audit/audit.js'
import type { VerificationPolicy } from '../services/auth-service.js'
import type { SweeperHandle } from './inventory-reservation-sweeper.js'

const COMMAND = 'customer.purgeUnconfirmed'

/** How long after its last write an account never confirmed is kept: well past the mail funnel's 7 days. */
export const UNCONFIRMED_ACCOUNT_TTL_MS = 30 * 24 * 3_600_000

export interface UnconfirmedAccountSweeperDeps {
  store: CommandStore
  repos: Pick<
    Repositories,
    'customer' | 'refreshToken' | 'passwordResetToken' | 'emailVerificationToken'
  >
  publisher: EventPublisher
  logger: Logger
  verification: VerificationPolicy
  intervalMs?: number
  ttlMs?: number
  /** Ids listed per page; a pass reads as many pages as it takes to reach every due account. */
  batchSize?: number
  now?: () => Date
}

/**
 * Removes accounts asked to confirm their address that never did, once `ttlMs` has passed since the row was last
 * written and no order or open link keeps them. Only under `required`: under `off` a pending account signs in.
 */
export function startUnconfirmedAccountSweeper(deps: UnconfirmedAccountSweeperDeps): SweeperHandle {
  const { store, repos, publisher } = deps
  const intervalMs = deps.intervalMs ?? 3_600_000
  const ttlMs = deps.ttlMs ?? UNCONFIRMED_ACCOUNT_TTL_MS
  const batchSize = deps.batchSize ?? 200
  const now = deps.now ?? (() => new Date())
  const logger = deps.logger.child({ sweeper: 'unconfirmed-accounts' })
  let running = false

  // One transaction and one command per account: a scope's entry is held in the first transaction it notes in, so a
  // command over the pass would name only the first account, and one failure would undo the rest. The delete re-checks
  // the whole predicate, so an account written since it was listed, or removed by another replica, is left alone.
  const remove = (id: string, window: { before: Date; now: Date }): Promise<boolean> =>
    auditedCommand(store, COMMAND, () =>
      store.transaction(async (tx) => {
        if (!(await repos.customer.deleteUnconfirmed(tx, id, window))) return false
        audit.note(COMMAND, [{ type: 'customer', id }])
        await repos.refreshToken.deleteByCustomer(tx, id)
        await repos.passwordResetToken.deleteByCustomer(tx, id)
        await repos.emailVerificationToken.deleteByCustomer(tx, id)
        await publisher.publish(EVT_CUSTOMER_DELETED, { customerId: id })
        return true
      }),
    )

  async function pass(): Promise<void> {
    const at = now()
    const window = { before: new Date(at.getTime() - ttlMs), now: at }
    let removed = 0
    let failed = 0
    // Pages follow the id order rather than "whatever is still due", so a pass ends even when a removal fails.
    let after: string | undefined
    for (;;) {
      const ids = await store.read((tx) =>
        repos.customer.listUnconfirmed(tx, {
          ...window,
          ...(after !== undefined && { after }),
          limit: batchSize,
        }),
      )
      for (const id of ids) {
        try {
          if (await remove(id, window)) removed += 1
        } catch (err) {
          failed += 1
          logger.error(
            { err, customerId: id },
            'could not remove an unconfirmed account; it stays for the next run',
          )
        }
      }
      if (ids.length < batchSize) break
      after = ids[ids.length - 1]
    }
    if (removed > 0 || failed > 0) logger.info({ removed, failed }, 'removed unconfirmed accounts')
  }

  async function tick(): Promise<void> {
    if (deps.verification !== 'required' || running) return
    running = true
    try {
      await runWithCorrelation(newCorrelationId('sweep:unconfirmed-accounts'), () =>
        runAsActor({ kind: 'system', id: 'unconfirmed-accounts' }, pass),
      )
    } catch (err) {
      logger.error({ err }, 'unconfirmed account sweep failed')
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
