import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe } from 'vitest'
import { adapterContext, runSearchContract } from '@nymbalhq/contract-tests'
import { encodeSearchCursor } from '@nymbalhq/platform'
import type { SearchAdapter } from '@nymbalhq/types'
import { createAdapter } from '../../packages/adapters/search/algolia/src/index.js'
import {
  startFakeAlgolia,
  type FakeAlgolia,
} from '../../packages/adapters/search/algolia/src/tests/fake-algolia.js'

// AC-1: the published SearchAdapter contract, facets, the cursor cases (the cursor is native's offset) and the
// downtime cases included, for `algolia` against the in-process fake Algolia, on one index for the file. Ranking is
// Algolia's own, so the ranking case does not run.
//
// The same suite runs against a real Algolia app when ALGOLIA_APP_ID, ALGOLIA_API_KEY (a key that may write and
// delete indexes) and ALGOLIA_INDEX are all set: three runs per property, on an index of its own named
// `<ALGOLIA_INDEX>-<run>`, deleted afterwards. That run checks the readings the fake takes (its header lists them).
// Without the three variables it does not run.

type Config = { appId: string; apiKey: string; indexName: string; host?: string }

async function build(config: Config): Promise<SearchAdapter> {
  const adapter = (await createAdapter(adapterContext('search', config))) as SearchAdapter
  await adapter.initialize(config)
  return adapter
}

let fake: FakeAlgolia
let deadHost = ''
const fakeConfig = (): Config => ({
  appId: 'FAKEAPP',
  apiKey: 'fake-admin-key',
  indexName: `contract-${randomUUID().slice(0, 8)}`,
  host: fake.host,
})
let onFake: Config

beforeAll(async () => {
  fake = await startFakeAlgolia()
  onFake = fakeConfig()
  const dead = await startFakeAlgolia()
  deadHost = dead.host
  await dead.close()
})
afterAll(async () => {
  await fake.close()
})

runSearchContract('algolia (fake Algolia)', () => build(onFake), {
  facets: true,
  cursorAt: encodeSearchCursor,
  unreachable: () => build({ ...onFake, host: deadHost }),
})

const real = {
  appId: process.env['ALGOLIA_APP_ID'] ?? '',
  apiKey: process.env['ALGOLIA_API_KEY'] ?? '',
  index: process.env['ALGOLIA_INDEX'] ?? '',
}
const onRealApp = real.appId !== '' && real.apiKey !== '' && real.index !== ''

describe.runIf(onRealApp)(
  'a real Algolia app (ALGOLIA_APP_ID, ALGOLIA_API_KEY, ALGOLIA_INDEX)',
  () => {
    const config: Config = {
      appId: real.appId,
      apiKey: real.apiKey,
      indexName: `${real.index}-${randomUUID().slice(0, 8)}`,
    }

    afterAll(async () => {
      await fetch(
        `https://${real.appId}.algolia.net/1/indexes/${encodeURIComponent(config.indexName)}`,
        {
          method: 'DELETE',
          headers: { 'X-Algolia-Application-Id': real.appId, 'X-Algolia-API-Key': real.apiKey },
          signal: AbortSignal.timeout(10_000),
        },
      ).catch(() => undefined)
    })

    runSearchContract('algolia (real app)', () => build(config), {
      facets: true,
      cursorAt: encodeSearchCursor,
      numRuns: 3,
      unreachable: () => build({ ...config, host: deadHost }),
    })
  },
)
