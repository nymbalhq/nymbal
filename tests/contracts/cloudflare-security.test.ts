import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runSecurityContract } from '@nymbalhq/contract-tests'
import { createAdapter } from '@nymbalhq/security-cloudflare'
import { AdapterError } from '@nymbalhq/types'
import {
  startFakeCloudflare,
  type FakeCloudflare,
} from '../../packages/adapters/security/cloudflare/src/tests/fake-cloudflare.js'
import {
  TOKEN,
  adapterContext,
  securityConfig,
} from '../../packages/adapters/security/cloudflare/src/tests/support.js'

// AC-8: the published SecurityAdapter contract passes for `cloudflare` against the fake Cloudflare API, the downtime
// cases included: with the fake stopped, `validate()` rejects within the case time and `healthCheck()` reports down.
// Beside it: `initialize` makes no request, and a refused connection is an AdapterError rather than a hang.

let live: FakeCloudflare
let zoneId = ''
let deadBase = ''

beforeAll(async () => {
  live = await startFakeCloudflare()
  zoneId = live.addZone({ plan: 'pro', token: TOKEN })
  const dead = await startFakeCloudflare()
  deadBase = dead.url
  await dead.close()
})
afterAll(async () => {
  await live.close()
})

async function build(apiBase: string) {
  const cloudflare = { zoneId, apiToken: TOKEN, apiBase }
  const adapter = await createAdapter(adapterContext(cloudflare))
  await adapter.initialize(cloudflare)
  return adapter
}

runSecurityContract('cloudflare', () => build(live.url), {
  unreachable: () => build(deadBase),
})

describe('AC-8: requests the contract does not see', () => {
  it('AC-8: createAdapter and initialize make no request to the API', async () => {
    const before = live.requests.length
    await build(live.url)
    expect(live.requests.length).toBe(before)
  })

  it('AC-8: with the API unreachable, validate rejects with an AdapterError within the 5 s request timeout', async () => {
    const adapter = await build(deadBase)
    const started = Date.now()
    const error = await adapter
      .validate(securityConfig({ zoneId, apiToken: TOKEN, apiBase: deadBase }))
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(error).toBeInstanceOf(AdapterError)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})
