import { runDocumentStoreContract } from '@nymbalhq/contract-tests'
import { documentsOnClock } from './memory-documents'

// The control for the replaceCollection breakers: the in-memory store passes every case of the published document
// store suite, replaceCollection's among them.
const { make, options } = documentsOnClock()
runDocumentStoreContract('in-memory documents', () => make(), options)
