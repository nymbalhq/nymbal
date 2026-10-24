import { runPaymentsContract } from '@nymbalhq/contract-tests'
import { memoryPayments } from './memory-payments'

// The control for the payments breaker: a correct in-memory adapter passes every case of the published payments suite.
runPaymentsContract('memory payments', () => memoryPayments())
