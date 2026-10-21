import { runMediaStorageContract, type MediaStorageContractOptions } from '@nymbalhq/contract-tests'
import { fetchUrl, localMedia } from './local-media'

// The control for the media health breaker: local-fs passes every case of the published media suite.
const options: MediaStorageContractOptions = { fetchUrl }
runMediaStorageContract('local-fs', localMedia, options)
