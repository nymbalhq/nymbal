import { runMediaStorageContract, type MediaStorageContractOptions } from '@nymbalhq/contract-tests'
import { fetchUrl, localMedia, withoutHealth } from './local-media'

// P2-13 AC-5: local-fs without healthCheck (a primitive the type allows) must fail the health case, and only it.
const options: MediaStorageContractOptions = { fetchUrl }
runMediaStorageContract('local-fs, no healthCheck', () => withoutHealth(localMedia()), options)
