import { runDocumentStoreContract } from '@nymbalhq/contract-tests'
import { documentsOnClock } from './memory-documents'

// P3-02 AC-1: a replaceCollection that empties the collection before reading its source must fail the failing-source
// case, and only replaceCollection cases.
const { make, options } = documentsOnClock()
runDocumentStoreContract(
  'in-memory documents, replace empties first',
  () => make('failure-empties'),
  options,
)
