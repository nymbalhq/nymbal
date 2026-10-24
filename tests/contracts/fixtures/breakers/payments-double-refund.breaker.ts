import { runPaymentsContract } from '@nymbalhq/contract-tests'
import { memoryPayments } from './memory-payments'

// The control's twin that ignores the idempotency key (a retry refunds again) must fail the idempotency case, and
// only it.
runPaymentsContract('memory payments, key ignored', () =>
  memoryPayments({ ignoreIdempotencyKey: true }),
)
