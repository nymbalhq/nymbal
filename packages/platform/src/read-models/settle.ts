import type { DocumentStoreAdapter } from '@nymbalhq/types'
import type { DocumentWrite } from './builders.js'

/** A round that still differs from the one before it after this many writes throws, so the event is retried. */
const SETTLE_ROUNDS = 3

export interface DocumentKey {
  collection: string
  key: string
}

/** One round of a reprojection: the documents its entity's rows build now, and the keys to remove when it writes. */
export interface Projected {
  puts: DocumentWrite[]
  /** Read just before the round writes, since the round's own puts replace what it reads. */
  deletes?: () => Promise<DocumentKey[]>
}

const idOf = (k: DocumentKey): string => `${k.collection}\u0000${k.key}`

/**
 * Writes an entity's documents, then builds them again from its rows until a round builds what the round before it
 * wrote. Two reprojections of one entity (a catch-up beside a live server, or two replicas) can land their writes in
 * the wrong order; the one that lands last then sees the newer rows on its next read and writes them. A key written in
 * an earlier round and not kept by the current one is deleted, so a stale round leaves nothing behind.
 */
export async function settle(
  documentStore: DocumentStoreAdapter,
  what: string,
  project: () => Promise<Projected>,
): Promise<void> {
  const written = new Map<string, DocumentKey>()
  let last: string | null = null
  for (let round = 1; ; round += 1) {
    const next = await project()
    const signature = JSON.stringify(next.puts)
    if (signature === last) return
    const kept = new Set(next.puts.map(idOf))
    const dropped = [...written.values()].filter((k) => !kept.has(idOf(k)))
    if (next.puts.length === 0 && dropped.length === 0 && next.deletes === undefined) return
    if (round > SETTLE_ROUNDS) throw new Error(`${what} did not settle in ${SETTLE_ROUNDS} rounds`)
    const deletes = [...((await next.deletes?.()) ?? []), ...dropped].filter(
      (k) => !kept.has(idOf(k)),
    )
    for (const w of next.puts) {
      await documentStore.put(w.collection, w.key, w.doc)
      written.set(idOf(w), { collection: w.collection, key: w.key })
    }
    for (const k of deletes) {
      await documentStore.delete(k.collection, k.key)
      written.delete(idOf(k))
    }
    last = signature
  }
}
