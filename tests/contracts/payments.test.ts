import { runPaymentsContract } from '@nymbalhq/contract-tests'
import { createNativeStubPaymentsAdapter, createLogger } from '@nymbalhq/platform'

// The payments contract on the native stub, the refund idempotency case included, and, since `signedWebhook` is given,
// parsing one webhook twice. The stub verifies no signature, so its "signed" webhook is the unsigned JSON body it
// reads, with an event id so two parses can be equal.

const logger = createLogger({ pretty: false, level: 'error' })

runPaymentsContract('native-stub', () => createNativeStubPaymentsAdapter({ logger }), {
  signedWebhook: () => ({
    rawBody: JSON.stringify({
      id: 'evt_stub_contracts',
      kind: 'payment.captured',
      paymentIntentId: 'pi_stub_contracts_not_held',
      amountMinor: 1234,
      currency: 'GBP',
    }),
    signature: '',
  }),
})
