import { runWebhookContract } from '@nymbalhq/contract-tests'
import type { WebhookDelivery } from '@nymbalhq/types'
import { createTestHooksAdapter } from '../../../../packages/platform/tests/support/test-hooks'
import { webhookOptions } from './webhook-deliveries'

/** A payload as an SDK hands it back: an object, but of its own class, not a plain JSON object. */
class ParcelEvent {
  constructor(fields: Record<string, unknown>) {
    Object.assign(this, fields)
  }
}

// The control's twin whose events keep their own declared types but carry class-instance payloads, which the kernel
// refuses on every live delivery, must fail the namespace case, and only it.
runWebhookContract(
  'test-hooks, class-instance payloads',
  () => {
    const adapter = createTestHooksAdapter()
    const receive = adapter.receiveWebhook!
    return {
      ...adapter,
      async receiveWebhook(rawBody, headers): Promise<WebhookDelivery> {
        const delivery = await receive(rawBody, headers)
        return {
          ...delivery,
          events: delivery.events.map((event) => ({
            type: event.type,
            payload: new ParcelEvent(event.payload) as unknown as Record<string, unknown>,
          })),
        }
      },
    }
  },
  webhookOptions,
)
