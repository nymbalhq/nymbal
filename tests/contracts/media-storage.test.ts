import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { runMediaStorageContract, type MediaStorageContractOptions } from '@nymbalhq/contract-tests'
import { createLocalFsMediaStorage } from '@nymbalhq/platform'

// runMediaStorageContract on local-fs puts bytes and reads the returned url back through the `fetchUrl` option; for
// local-fs that is the file under the storage root the url names. The suite includes the health case.

const URL_PREFIX = '/primitives-media'
const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

let root = ''
const make = async () => {
  root = mkdtempSync(join(tmpdir(), 'primitives-media-'))
  roots.push(root)
  return createLocalFsMediaStorage({ root, urlPrefix: URL_PREFIX })
}

/** The bytes under the root of the storage `make` returned last, at the path the url names after its prefix. */
const fetchUrl = async (url: string): Promise<Uint8Array> => {
  if (!url.startsWith(`${URL_PREFIX}/`)) throw new Error(`${url} is not under ${URL_PREFIX}/`)
  return new Uint8Array(readFileSync(join(root, url.slice(URL_PREFIX.length + 1))))
}

const options: MediaStorageContractOptions = { fetchUrl }

runMediaStorageContract('local-fs', make, options)
