import {
  EVT_INVENTORY_CHANGED,
  type EventBusAdapter,
  type EventHandler,
  type InventoryChangedV1Payload,
} from '@nymbalhq/types'
import { subscribeDerived, type DerivedHandler } from '../derived.js'
import { productReprojector, type ProductProjectionDeps } from './product-projection.js'

export interface RegisterInventoryProjectionDeps extends ProductProjectionDeps {
  eventBus: EventBusAdapter
}

/** A stock change re-projects the variant's product, so `products` and `products-by-category` both carry it. */
export function inventoryProjection(deps: ProductProjectionDeps): DerivedHandler[] {
  const products = productReprojector(deps)
  const { repos, logger } = deps

  const handler: EventHandler<InventoryChangedV1Payload> = async (event) => {
    const { variantId, newQty } = event.payload
    const variant = await repos.variant.store.read((tx) => repos.variant.findById(tx, variantId))
    if (!variant) return
    await products.reproject(variant.productId)
    logger.debug({ variantId, newQty }, 'inventory projection updated')
  }

  return [
    {
      name: 'inventory-projection',
      types: [EVT_INVENTORY_CHANGED],
      handle: handler as EventHandler,
    },
  ]
}

export async function registerInventoryProjection(
  deps: RegisterInventoryProjectionDeps,
): Promise<void> {
  await subscribeDerived(deps.eventBus, inventoryProjection(deps))
}
