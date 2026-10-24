import { runMediaStorageContract, type MediaStorageContractOptions } from '@nymbalhq/contract-tests'
import { fetchUrl, localMedia, withoutHealth } from './local-media'

// Local-fs without healthCheck (a primitive the type allows) must fail the health case, and only it.
const options: MediaStorageContractOptions = { fetchUrl }
runMediaStorageContract('local-fs, no healthCheck', () => withoutHealth(localMedia()), options)
