import { runPaymentsContract } from '@nymbalhq/contract-tests'
import { createNativeStubPaymentsAdapter, createLogger } from '@nymbalhq/platform'

// The payments contract on the native stub, P2-13 AC-4 (spec P2-13-contract-tests-public) included: the refund
// idempotency case, and, since `signedWebhook` is given, parsing one webhook twice. The stub verifies no signature, so
// its "signed" webhook is the unsigned JSON body it reads (decision 3), with an event id so two parses can be equal.

const logger = createLogger({ pretty: false, level: 'error' })

runPaymentsContract('native-stub', () => createNativeStubPaymentsAdapter({ logger }), {
  signedWebhook: () => ({
    rawBody: JSON.stringify({
      id: 'evt_stub_p2_13',
      kind: 'payment.captured',
      paymentIntentId: 'pi_stub_p2_13_not_held',
      amountMinor: 1234,
      currency: 'GBP',
    }),
    signature: '',
  }),
})
