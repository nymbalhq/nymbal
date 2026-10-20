/**
 * The values each infrastructure slot accepts: only what is built. `in-memory`, `in-process` and `local-fs` are the
 * kernel's own; `redis`, `postgres-jsonb`, `redis-streams` and `s3` live in `@nymbalhq/*` packages the kernel loads
 * only when the config names them.
 */
export const KNOWN_INFRASTRUCTURE = {
  commandStore: ['sqlite', 'postgres'],
  documentStore: ['in-memory', 'redis', 'postgres-jsonb'],
  eventBus: ['in-process', 'redis-streams'],
  media: ['local-fs', 's3'],
} as const satisfies Readonly<Record<string, readonly [string, ...string[]]>>

export type InfrastructureSlot = keyof typeof KNOWN_INFRASTRUCTURE

/** Keys that drove nothing and were removed; a config that still sets one is told to delete it. */
export const REMOVED_INFRASTRUCTURE_KEYS = ['cloud', 'compute'] as const
