import type { EventHandler, Logger, NymbalEvent } from '@nymbalhq/types'
import type { ProcessedEventRepository } from '../repositories/processed-event.js'

export interface IdempotencyOptions {
  repo: ProcessedEventRepository
  logger?: Logger
}

export function withIdempotency<T = unknown>(
  handlerName: string,
  handler: EventHandler<T>,
  { repo, logger }: IdempotencyOptions,
): EventHandler<T> {
  return async (event: NymbalEvent<T>) => {
    const { store } = repo
    if (await store.read((tx) => repo.seen(tx, handlerName, event.id))) {
      logger?.debug(
        { handlerName, eventId: event.id, type: event.type },
        'idempotency: skipping duplicate event',
      )
      return
    }
    await handler(event)
    await store.transaction((tx) => repo.markProcessed(tx, handlerName, event.id, new Date()))
  }
}
