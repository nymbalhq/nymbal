import { runWebhookContract } from '@nymbalhq/contract-tests'
import {
  createTestHooksAdapter,
  sampleBody,
  signedDelivery,
  tampered,
} from '../../packages/platform/tests/support/test-hooks'

// The webhook contract on the kernel's test provider: one signed delivery of two events, received twice, and the same
// delivery with one byte changed.

const delivery = () => signedDelivery(sampleBody('dlv_contracts', 2))

runWebhookContract('test-hooks', () => createTestHooksAdapter(), {
  delivery,
  tampered: () => tampered(delivery()),
})
