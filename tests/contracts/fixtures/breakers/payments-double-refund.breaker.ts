import { runPaymentsContract } from '@nymbalhq/contract-tests'
import { memoryPayments } from './memory-payments'

// P2-13 AC-4: the control's twin that ignores the idempotency key (a retry refunds again) must fail the idempotency
// case, and only it.
runPaymentsContract('memory payments, key ignored', () =>
  memoryPayments({ ignoreIdempotencyKey: true }),
)
