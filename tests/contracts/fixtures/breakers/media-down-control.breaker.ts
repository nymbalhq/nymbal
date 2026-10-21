import { runMediaStorageContract, type MediaStorageContractOptions } from '@nymbalhq/contract-tests'
import { deadMedia, fetchUrl, localMedia } from './local-media'

// The control for the downtime breakers: local-fs, and as `unreachable` local-fs on a root it cannot write, passes every
// case, the downtime cases included.
const options: MediaStorageContractOptions = { fetchUrl, unreachable: deadMedia }
runMediaStorageContract('local-fs, dead root', localMedia, options)
