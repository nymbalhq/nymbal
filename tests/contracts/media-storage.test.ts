import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { runMediaStorageContract, type MediaStorageContractOptions } from '@nymbalhq/contract-tests'
import { createLocalFsMediaStorage } from '@nymbalhq/platform'

// P2-02 AC-4 on local-fs (spec P2-02-primitives-are-protocols): runMediaStorageContract puts bytes and reads the
// returned url back through `fetchUrl`; for local-fs that is the file under the storage root the url names. P2-13
// (spec P2-13-contract-tests-public, decision 3): `fetchUrl` is an option now, and the suite adds the health case.

const URL_PREFIX = '/p2-02-media'
const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

let root = ''
const make = async () => {
  root = mkdtempSync(join(tmpdir(), 'p2-02-media-'))
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
