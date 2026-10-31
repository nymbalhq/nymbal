/** The command store's dialects: a kernel dialect, not an adapter slot, so it stays a closed list. */
export const COMMAND_STORES = ['sqlite', 'postgres'] as const

/** The infrastructure slots: the command store, and the three that take an adapter block. */
export type InfrastructureSlot = 'commandStore' | 'documentStore' | 'eventBus' | 'media'

/** Keys that drove nothing and were removed; a config that still sets one is told to delete it. */
export const REMOVED_INFRASTRUCTURE_KEYS = ['cloud', 'compute'] as const
