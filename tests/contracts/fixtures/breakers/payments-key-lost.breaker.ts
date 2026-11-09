import { runPaymentsContract } from '@nymbalhq/contract-tests'
import { memoryPayments } from './memory-payments'

// The control's twin that loseRefundKey.
runPaymentsContract('memory payments, lookup refunds', () =>
  memoryPayments({ loseRefundKey: true }),
)
