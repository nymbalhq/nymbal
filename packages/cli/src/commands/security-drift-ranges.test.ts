import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import repoConfig from '../../../../nymbal.config.js'
import { cliEnv, runCli, type CliRun } from '../../../../tests/support/doctor.js'
import { install, workspace } from '../../../../tests/support/project.js'
import { CLOUDFLARE_IPS } from '../../../adapters/security/cloudflare/src/ips.js'
import {
  startFakeCloudflare,
  type FakeCloudflare,
} from '../../../adapters/security/cloudflare/src/tests/fake-cloudflare.js'

// `nymbal security:drift` also compares Cloudflare's live address ranges (GET /ips) with the snapshot this version
// ships, which a web server config from `nymbal deploy nginx|apache|caddy` admits. A change is a note naming both etags
// and the snapshot's date; a failed read is a note too. Neither changes the exit code: 0 in sync, 1 on a rule's drift.
// Spawns the built CLI (`pnpm build` first).

const RANGES_NOTE = /note: .*address ranges/i
const UNREADABLE = "could not read Cloudflare's address ranges"

let fake: FakeCloudflare
const dirs: string[] = []
beforeAll(async () => {
  fake = await startFakeCloudflare()
})
afterAll(async () => {
  await fake.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

let zones = 0
/** A project on a fresh zone, applied, so drift starts in sync. */
async function applied(): Promise<{ zoneId: string; drift(json?: boolean): Promise<CliRun> }> {
  zones += 1
  const token = `cf-ranges-token-${zones}-Pb5Vr4Ns8G`
  const zoneId = fake.addZone({ plan: 'pro', token })
  const dir = mkdtempSync(join(tmpdir(), 'nymbal-cf-ranges-'))
  dirs.push(dir)
  install(dir, workspace('@nymbalhq/security-cloudflare'))
  const security = {
    ...repoConfig.security,
    adapter: 'cloudflare',
    rateLimit: { '/api/auth/login': { requests: 10, window: '1m', action: 'block' } },
    botProtection: { mode: 'off', allowList: [] },
    geo: { block: ['RU'] },
    customRules: [],
    cloudflare: { zoneId, apiToken: token, apiBase: fake.url },
  }
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify({ ...repoConfig, security }, null, 2)}\n`,
  )
  // A store with the secret already set: apply writes no .env.
  const env = cliEnv({ NYMBAL_ORIGIN_SECRET: 'ranges-origin-secret-Qm4Xv8Lp2Rt6Zw0Ka' })
  const apply = await runCli(['security:apply'], { cwd: dir, env })
  expect(apply.code, apply.out).toBe(0)
  return {
    zoneId,
    drift: (json = false) =>
      runCli(json ? ['security:drift', '--json'] : ['security:drift'], { cwd: dir, env }),
  }
}

const notes = (run: CliRun) => run.out.split('\n').filter((line) => RANGES_NOTE.test(line))

describe('AC-16: security:drift notes a change in Cloudflare’s ranges', () => {
  it('AC-16: with GET /ips’s etag equal to the snapshot’s there is no ranges note; with another etag the note names both etags and the snapshot’s fetchedAt, and the exit code is 0 in sync and 1 on a rule’s drift either way', async () => {
    const p = await applied()
    fake.setIps({
      etag: CLOUDFLARE_IPS.etag,
      ipv4_cidrs: CLOUDFLARE_IPS.ipv4Cidrs,
      ipv6_cidrs: CLOUDFLARE_IPS.ipv6Cidrs,
    })
    const same = await p.drift()
    const live = `${CLOUDFLARE_IPS.etag}-changed`
    fake.setIps({ etag: live, ipv4_cidrs: ['198.51.100.0/24'], ipv6_cidrs: ['2001:db8::/32'] })
    const changed = await p.drift()
    fake.edit(p.zoneId, 'http_request_firewall_custom', 'nymbal:geo:block', {
      expression: '(ip.src.country in {"FR"})',
    })
    const drifted = await p.drift()

    expect([same.code, changed.code, drifted.code], changed.out).toEqual([0, 0, 1])
    expect(notes(same)).toEqual([])
    expect(notes(changed).length).toBe(notes(same).length + 1)
    for (const run of [changed, drifted]) {
      const [note] = notes(run)
      expect(notes(run).length, run.out).toBe(1)
      for (const fact of [CLOUDFLARE_IPS.etag, live, CLOUDFLARE_IPS.fetchedAt]) {
        expect(note).toContain(fact)
      }
    }
  }, 120_000)

  it('AC-16: drift --json carries cloudflareIps with the snapshot’s and the live etag; with GET /ips answering 500 drift notes it could not read the ranges and exits as without it', async () => {
    const p = await applied()
    const live = `${CLOUDFLARE_IPS.etag}-json`
    fake.setIps({ etag: live, ipv4_cidrs: ['198.51.100.0/24'], ipv6_cidrs: [] })
    const json = await p.drift(true)
    fake.failIps(500)
    const unreadable = await p.drift()
    const unreadableJson = await p.drift(true)

    expect([json.code, unreadable.code, unreadableJson.code], unreadable.out).toEqual([0, 0, 0])
    expect((JSON.parse(json.stdout) as { cloudflareIps?: unknown }).cloudflareIps).toEqual({
      snapshot: CLOUDFLARE_IPS.etag,
      live,
    })
    expect(unreadable.out).toContain(UNREADABLE)
    expect(
      (JSON.parse(unreadableJson.stdout) as { cloudflareIps?: unknown }).cloudflareIps,
    ).toEqual({
      snapshot: CLOUDFLARE_IPS.etag,
      live: null,
    })
  }, 120_000)
})
