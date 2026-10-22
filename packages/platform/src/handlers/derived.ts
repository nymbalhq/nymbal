import type { EventBusAdapter, EventHandler } from '@nymbalhq/types'

/**
 * One subscription of a projection: the bus delivers live events to it, and a read-model rebuild calls it directly in
 * its catch-up, so a failure there is seen rather than logged by the bus.
 */
export interface DerivedHandler {
  name: string
  types: readonly string[]
  handle: EventHandler
}

export async function subscribeDerived(
  eventBus: EventBusAdapter,
  handlers: readonly DerivedHandler[],
): Promise<void> {
  for (const h of handlers) {
    const pattern = h.types.length === 1 ? h.types[0]! : [...h.types]
    await eventBus.subscribe(pattern, h.handle, { name: h.name, derived: true })
  }
}
