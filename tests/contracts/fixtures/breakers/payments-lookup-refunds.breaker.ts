import { runPaymentsContract } from '@nymbalhq/contract-tests'
import { memoryPayments } from './memory-payments'

// The control's twin that lookupRefunds.
runPaymentsContract('memory payments, lookup refunds', () =>
  memoryPayments({ lookupRefunds: true }),
)
