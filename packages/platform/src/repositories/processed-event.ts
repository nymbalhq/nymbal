import type { DocumentStoreAdapter } from '@nymbal/types'

const COLLECTION = '_processed_events'

export interface ProcessedEventEntry {
  handlerName: string
  eventId: string
  processedAt: string
}

export interface ProcessedEventRepository {
  seen(handlerName: string, eventId: string): Promise<boolean>
  markProcessed(handlerName: string, eventId: string): Promise<void>
}

export function createProcessedEventRepository(
  documentStore: DocumentStoreAdapter,
  options: { ttlSeconds?: number } = {},
): ProcessedEventRepository {
  const ttl = options.ttlSeconds ?? 60 * 60 * 24 * 7
  const key = (handler: string, eventId: string) => `${handler}::${eventId}`
  return {
    async seen(handlerName, eventId) {
      const existing = await documentStore.get<ProcessedEventEntry>(COLLECTION, key(handlerName, eventId))
      return existing !== null
    },
    async markProcessed(handlerName, eventId) {
      await documentStore.put<ProcessedEventEntry>(
        COLLECTION,
        key(handlerName, eventId),
        { handlerName, eventId, processedAt: new Date().toISOString() },
        { ttl },
      )
    },
  }
}
