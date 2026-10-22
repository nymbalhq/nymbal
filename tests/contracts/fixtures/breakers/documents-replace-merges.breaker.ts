import { runDocumentStoreContract } from '@nymbalhq/contract-tests'
import { documentsOnClock } from './memory-documents'

// P3-02 AC-1: a replaceCollection that keeps the old keys must fail the exact-set (stale keys) case, and only
// replaceCollection cases.
const { make, options } = documentsOnClock()
runDocumentStoreContract('in-memory documents, replace merges', () => make('merges'), options)
