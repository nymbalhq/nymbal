import type { ShopperOrder } from '@nymbalhq/types'
import { OrderStatusRefresh } from '@/components/client/OrderStatusRefresh'
import { renderNymbal } from '@/lib/render'
import { OrderView, summaryAttributes } from './OrderView'

/** The order its key opens, rendered on the server with the elements' server HTML. */
export function OrderDetails({ order, orderKey }: { order: ShopperOrder; orderKey?: string }) {
  const timeline = JSON.stringify(order.timeline ?? [])
  return (
    <OrderView
      order={order}
      timelineHtml={renderNymbal('nymbal-order-timeline', { entries: timeline }).__html}
      summaryHtml={renderNymbal('nymbal-order-summary', summaryAttributes(order)).__html}
      refresh={
        <OrderStatusRefresh
          orderNumber={order.orderNumber}
          orderKey={orderKey}
          status={order.status}
        />
      }
    />
  )
}
