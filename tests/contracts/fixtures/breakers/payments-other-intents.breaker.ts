import { runPaymentsContract } from '@nymbalhq/contract-tests'
import { memoryPayments } from './memory-payments'

// The control's twin that listOtherIntents.
runPaymentsContract('memory payments, lookup refunds', () =>
  memoryPayments({ listOtherIntents: true }),
)
