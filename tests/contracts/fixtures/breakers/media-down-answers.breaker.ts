import { runMediaStorageContract, type MediaStorageContractOptions } from '@nymbalhq/contract-tests'
import { fetchUrl, localMedia, stillAnswering } from './local-media'

// An `unreachable` that still answers (health only `degraded`, put stores) must fail the downtime cases, and only
// them: a downtime case that passes on a dead dependency cannot certify.
const options: MediaStorageContractOptions = { fetchUrl, unreachable: stillAnswering }
runMediaStorageContract('local-fs, unreachable still answers', localMedia, options)
