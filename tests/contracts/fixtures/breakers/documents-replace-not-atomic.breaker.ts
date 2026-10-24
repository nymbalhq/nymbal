import { runDocumentStoreContract } from '@nymbalhq/contract-tests'
import { documentsOnClock } from './memory-documents'

// A replaceCollection that deletes and puts a macrotask apart must fail the concurrent-reader case, and only
// replaceCollection cases.
const { make, options } = documentsOnClock()
runDocumentStoreContract(
  'in-memory documents, replace not atomic',
  () => make('not-atomic'),
  options,
)
