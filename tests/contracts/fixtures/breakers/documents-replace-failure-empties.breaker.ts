import { runDocumentStoreContract } from '@nymbalhq/contract-tests'
import { documentsOnClock } from './memory-documents'

// A replaceCollection that empties the collection before reading its source must fail the failing-source case, and
// only replaceCollection cases.
const { make, options } = documentsOnClock()
runDocumentStoreContract(
  'in-memory documents, replace empties first',
  () => make('failure-empties'),
  options,
)
