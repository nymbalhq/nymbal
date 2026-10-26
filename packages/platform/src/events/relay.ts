import { AsyncLocalStorage } from 'node:async_hooks'
import type { EventBusAdapter, EventHandler, Logger } from '@nymbalhq/types'
import type { CommandStore } from '../db/command-store.js'
import type { EventLogRepository, LoggedEvent } from '../repositories/event-log.js'
import { outsideCorrelation } from './correlation.js'
import { outsideActor } from '../audit/actor.js'
import { outsideCommand } from '../audit/audit.js'

/** Hands committed events from the log to the bus. */
export interface Relay {
  /** Delivers every undelivered, non-dead event in `seq` order. Never rejects. */
  drain(): Promise<void>
  /** Drains on an interval (the timer does not keep the process alive). */
  start(): void
  /** Stops the interval and starts no new pass; resolves when the pass in flight, if any, has finished, so the
   *  store can be closed without cutting a delivery off between the handler and its bookkeeping. */
  stop(): Promise<void>
  /**
   * `handler`, run as part of a delivery: a drain it asks for (by running a command) returns at once instead of
   * waiting on the pass that waits on it. The app wraps every subscribed handler in it, so this holds whether the bus
   * calls the handler inside `publish` or from a consumer loop of its own.
   */
  asDelivery(handler: EventHandler): EventHandler
}

export interface CreateRelayOptions {
  store: CommandStore
  eventLog: EventLogRepository
  eventBus: EventBusAdapter
  logger: Logger
  /** Failed bus publishes after which an event is dead and never handed to the bus again. */
  maxAttempts?: number
  intervalMs?: number
  /** The wait before the first retry of a failed event (default `intervalMs`); each later wait doubles it. */
  retryDelayMs?: number
  /** The clock failures and retry waits are read from. */
  now?: () => Date
}

const PAGE_SIZE = 100

interface Deferred {
  promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** The subscriptions a bus's `handler_failed` rejection names, for the relay's log lines. */
function failedOf(err: unknown): { failed?: unknown[] } {
  const failed = (err as { context?: { failed?: unknown } } | null)?.context?.failed
  return Array.isArray(failed) ? { failed } : {}
}

export function createRelay(opts: CreateRelayOptions): Relay {
  const { store, eventLog } = opts
  const maxAttempts = opts.maxAttempts ?? 5
  const intervalMs = opts.intervalMs ?? 10_000
  const retryDelayMs = opts.retryDelayMs ?? intervalMs
  const now = opts.now ?? (() => new Date())
  const logger = opts.logger.child({ component: 'event-relay' })
  // Set around each bus publish and each subscribed handler: a drain asked for by a subscriber (one that ran a
  // command) must not wait for the drain that is delivering to it.
  const delivering = new AsyncLocalStorage<true>()

  let active = false
  // Resolved when `active` turns false, i.e. after the last chained follow-up pass.
  let idle: Deferred | undefined
  let followUp: Deferred | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false

  async function deliver({ event, attempts }: LoggedEvent): Promise<void> {
    try {
      // Looked up on every call: a wrapper installed on the bus instance after construction must see the event.
      await delivering.run(true, () => opts.eventBus.publish(event))
    } catch (err) {
      const at = now()
      const failures = attempts + 1
      // Backed off in the log, not in memory: every drain in between (each commit asks for one) and a restart see it.
      const retryAt = new Date(at.getTime() + retryDelayMs * 2 ** (failures - 1))
      await store.transaction((tx) =>
        eventLog.recordFailure(tx, event.id, at, maxAttempts, retryAt),
      )
      const context = {
        err,
        eventId: event.id,
        eventType: event.type,
        attempts: failures,
        ...failedOf(err),
      }
      if (failures >= maxAttempts) {
        logger.error(context, 'event delivery failed for the last time; the event is dead')
      } else {
        logger.warn(
          { ...context, retryAt: retryAt.toISOString() },
          'event delivery failed; the event stays in the log and is tried again from retryAt',
        )
      }
      return
    }
    await store.transaction((tx) => eventLog.markDelivered(tx, [event.id], new Date()))
  }

  /** One pass over the log. The cursor only spans this pass: a row that commits behind it is left for the next
   *  pass, which the committing transaction requests. */
  async function pass(): Promise<void> {
    try {
      let afterSeq = 0
      for (;;) {
        if (stopped) return
        const page = await store.read((tx) =>
          eventLog.listUndelivered(tx, PAGE_SIZE, afterSeq, now()),
        )
        for (const logged of page) {
          if (stopped) return
          afterSeq = logged.seq
          await deliver(logged)
        }
        if (page.length < PAGE_SIZE) return
      }
    } catch (err) {
      logger.error({ err }, 'event relay pass failed; undelivered events stay in the log')
    }
  }

  async function run(): Promise<void> {
    active = true
    try {
      await pass()
    } finally {
      const next = followUp
      followUp = undefined
      if (next === undefined) {
        active = false
        idle?.resolve()
        idle = undefined
      } else {
        // Still active: nothing can start a second pass alongside this one.
        void run().then(next.resolve)
      }
    }
  }

  function request(): Promise<void> {
    if (!active) {
      idle = deferred()
      // A pass delivers every operation's events, not only the requester's: its handlers run in no scope of the caller,
      // neither its correlation id nor its actor and command, so a handler's writes are never the caller's entry.
      return outsideCorrelation(() => outsideActor(() => outsideCommand(run)))
    }
    followUp ??= deferred()
    return followUp.promise
  }

  return {
    drain() {
      if (stopped) return Promise.resolve()
      const done = request()
      return delivering.getStore() === true ? Promise.resolve() : done
    },
    start() {
      if (timer !== undefined) return
      stopped = false
      timer = setInterval(() => void request(), intervalMs)
      timer.unref()
    },
    stop() {
      stopped = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      // A subscriber that stops the app would otherwise wait on the pass that is waiting on it.
      if (delivering.getStore() === true) return Promise.resolve()
      return idle?.promise ?? Promise.resolve()
    },
    asDelivery(handler) {
      return (event) => delivering.run(true, () => handler(event))
    },
  }
}

/**
 * The bus as subscribers see it: every handler runs as part of a relay delivery, so a command it runs does not wait
 * on the drain that is waiting on the handler, whether the bus calls it inside `publish` or from a consumer loop.
 */
export function deliveringBus(bus: EventBusAdapter, relay: Relay): EventBusAdapter {
  return {
    capabilities: () => bus.capabilities(),
    publish: (event) => bus.publish(event),
    publishBatch: (events) => bus.publishBatch(events),
    replay: (events) => bus.replay(events),
    subscribe: (pattern, handler, config) =>
      bus.subscribe(pattern, relay.asDelivery(handler), config),
    unsubscribe: (subscription) => bus.unsubscribe(subscription),
    close: () => bus.close(),
  }
}
