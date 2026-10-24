import { runMediaStorageContract, type MediaStorageContractOptions } from '@nymbalhq/contract-tests'
import { fetchUrl, localMedia, neverAnswering } from './local-media'

// An `unreachable` whose health and put never settle must fail the downtime cases within their bound, and only them.
const options: MediaStorageContractOptions = { fetchUrl, unreachable: neverAnswering }
runMediaStorageContract('local-fs, unreachable hangs', localMedia, options)
