import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cliEnv,
  doctorJson,
  migratedSqlite,
  runCli,
  type CliRun,
} from '../../../../../../tests/support/doctor.js'
import { install, workspace } from '../../../../../../tests/support/project.js'
import { storeConfig } from '../../../../../../tests/support/start.js'
import { CLOUDFLARE_IPS } from '../../src/ips.js'

// The origin lock on a real Cloudflare zone, run only by scripts/cloudflare-live.sh as the vitest project
// `cloudflare-live` (it alone sets NYMBAL_CLOUDFLARE_LIVE=1, which registers the project): never in CI or `pnpm test`.
// It proves what the fake can only assume: the transform rule's shape and header case, drift and doctor on the live
// API, GET /ips, and CF-Connecting-IP reaching the origin's limiter. It writes the zone's rules and the Fly app's
// NYMBAL_ORIGIN_SECRET; give it a throwaway free zone and a throwaway app running this branch.
//
//   CLOUDFLARE_LIVE_ZONE_ID     a zone on the free plan
//   CLOUDFLARE_LIVE_API_TOKEN   a token for it with Zone › Zone › Read, Zone › Zone WAF › Edit,
//                               Zone › Cache Rules › Edit and Zone › Transform Rules › Edit
//   NYMBAL_LIVE_ORIGIN_URL      the app's direct URL (https://<app>.fly.dev)
//   NYMBAL_LIVE_CDN_URL         the same app through the zone (https://shop.<zone>)
//   NYMBAL_LIVE_FLY_APP         the Fly app, for its secret and its logs (flyctl logged in)

const exec = promisify(execFile)

const INPUTS = [
  'CLOUDFLARE_LIVE_ZONE_ID',
  'CLOUDFLARE_LIVE_API_TOKEN',
  'NYMBAL_LIVE_ORIGIN_URL',
  'NYMBAL_LIVE_CDN_URL',
  'NYMBAL_LIVE_FLY_APP',
] as const
const missing = INPUTS.filter((name) => (process.env[name] ?? '').trim() === '')
if (missing.length > 0) {
  // A skip would read as a pass: the run fails, naming what it lacks.
  throw new Error(`cloudflare-live: missing ${missing.join(', ')}`)
}
const ZONE = process.env['CLOUDFLARE_LIVE_ZONE_ID']!
const TOKEN = process.env['CLOUDFLARE_LIVE_API_TOKEN']!
const ORIGIN = process.env['NYMBAL_LIVE_ORIGIN_URL']!.replace(/\/+$/, '')
const CDN = process.env['NYMBAL_LIVE_CDN_URL']!.replace(/\/+$/, '')
const FLY_APP = process.env['NYMBAL_LIVE_FLY_APP']!

const API = 'https://api.cloudflare.com/client/v4'
const TRANSFORM = 'http_request_late_transform'
const REF = 'nymbal:origin-lock'
const VAR = 'NYMBAL_ORIGIN_SECRET'

interface LiveRule {
  ref?: string
  [key: string]: unknown
}

async function cf<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; result: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  })
  const json = (await res.json().catch(() => ({}))) as { result?: T }
  return { status: res.status, result: json.result as T }
}

async function transformRules(): Promise<LiveRule[]> {
  const { status, result } = await cf<{ rules?: LiveRule[] }>(
    'GET',
    `/zones/${ZONE}/rulesets/phases/${TRANSFORM}/entrypoint`,
  )
  return status === 404 ? [] : (result.rules ?? [])
}

/** Every entrypoint ruleset's version, by phase: unchanged versions mean no write. */
async function versions(): Promise<Record<string, string>> {
  const { result } = await cf<Array<{ kind: string; phase: string; version: string }>>(
    'GET',
    `/zones/${ZONE}/rulesets`,
  )
  return Object.fromEntries(
    result.filter((r) => r.kind === 'zone').map((r) => [r.phase, r.version]),
  )
}

let dir = ''
let env: NodeJS.ProcessEnv = {}
const cli = (args: string[]): Promise<CliRun> => runCli(args, { cwd: dir, env, timeoutMs: 120_000 })
const secretInEnvFile = (): string | undefined =>
  readFileSync(join(dir, '.env'), 'utf8')
    .split('\n')
    .find((line) => line.startsWith(`${VAR}=`))
    ?.slice(VAR.length + 1)

beforeAll(async () => {
  const zone = await cf<{ plan?: { legacy_id?: string } }>('GET', `/zones/${ZONE}`)
  if (zone.status !== 200 || zone.result.plan?.legacy_id !== 'free') {
    throw new Error(
      `cloudflare-live: zone ${ZONE} is not a readable free-plan zone (status ${zone.status}, plan ${zone.result?.plan?.legacy_id}); nothing was written`,
    )
  }
  dir = mkdtempSync(join(tmpdir(), 'nymbal-cloudflare-live-'))
  install(dir, workspace('@nymbalhq/security-cloudflare'))
  const raw = storeConfig() as { security: Record<string, unknown> }
  const config = {
    ...raw,
    security: {
      ...raw.security,
      adapter: 'cloudflare',
      rateLimit: {},
      cloudflare: { zoneId: '__ZONE__', apiToken: '__TOKEN__' },
    },
  }
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify(config, null, 2)}\n`
      .replace('"__ZONE__"', "process.env['CLOUDFLARE_ZONE_ID']")
      .replace('"__TOKEN__"', "process.env['CLOUDFLARE_API_TOKEN']"),
  )
  writeFileSync(join(dir, '.env'), `NYMBAL_PUBLIC_URL=${CDN}\n`)
  const sqlitePath = join(dir, 'nymbal.db')
  await migratedSqlite(sqlitePath)
  env = cliEnv({
    CLOUDFLARE_ZONE_ID: ZONE,
    CLOUDFLARE_API_TOKEN: TOKEN,
    NYMBAL_SQLITE_PATH: sqlitePath,
    [VAR]: undefined,
    NYMBAL_PUBLIC_URL: undefined,
  })
}, 60_000)

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

describe('AC-17: the origin lock on a live free zone', () => {
  it('AC-17: apply writes nymbal:origin-lock sending the .env secret; drift exits 0; a second apply writes nothing; a deleted rule makes drift name it and doctor down; apply restores it', async () => {
    const first = await cli(['security:apply'])
    expect(first.code, first.out).toBe(0)
    const secret = secretInEnvFile()
    const rule = (await transformRules()).find((r) => r.ref === REF)
    const sent = (rule?.['action_parameters'] as { headers?: Record<string, { value?: string }> })
      ?.headers?.['X-Nymbal-Origin']?.value
    expect(secret === undefined ? 'no secret in .env' : sent === secret).toBe(true)

    const inSync = await cli(['security:drift'])
    const before = await versions()
    const second = await cli(['security:apply'])
    const after = await versions()
    expect([inSync.code, second.code], inSync.out + second.out).toEqual([0, 0])
    expect(after).toEqual(before)

    const kept = (await transformRules())
      .filter((r) => r.ref !== REF)
      .map(({ version: _v, last_updated: _u, ...r }) => r)
    const deleted = await cf('PUT', `/zones/${ZONE}/rulesets/phases/${TRANSFORM}/entrypoint`, {
      rules: kept,
    })
    expect(deleted.status).toBe(200)
    const drifted = await cli(['security:drift'])
    const doctor = await cli(['doctor', '--json'])
    const lock = doctorJson(doctor.stdout).checks.find((c) => c.name === 'origin lock')
    expect([drifted.code, lock?.status], drifted.out).toEqual([1, 'down'])
    expect(drifted.out).toContain(`${TRANSFORM}/${REF}`)

    const restored = await cli(['security:apply'])
    const settled = await cli(['security:drift'])
    expect([restored.code, settled.code], restored.out + settled.out).toEqual([0, 0])
    const all = [first, inSync, second, drifted, doctor, restored, settled]
      .map((r) => r.out)
      .join('\n')
    expect(secret !== undefined && all.includes(secret)).toBe(false)
  }, 600_000)

  it('AC-17: GET /ips answers ranges and an etag without a token, compared with the shipped snapshot and printed', async () => {
    const res = await fetch(`${API}/ips`, { signal: AbortSignal.timeout(15_000) })
    const body = (await res.json()) as {
      result?: { etag?: string; ipv4_cidrs?: string[]; ipv6_cidrs?: string[] }
    }
    const live = body.result ?? {}
    // eslint-disable-next-line no-console
    console.log(
      `cloudflare-live: GET /ips etag ${live.etag}; snapshot ${CLOUDFLARE_IPS.etag} (${CLOUDFLARE_IPS.fetchedAt}): ${live.etag === CLOUDFLARE_IPS.etag ? 'same' : 'changed'}`,
    )

    expect(res.status).toBe(200)
    expect(typeof live.etag).toBe('string')
    expect(Math.min(live.ipv4_cidrs?.length ?? 0, live.ipv6_cidrs?.length ?? 0)).toBeGreaterThan(0)
  }, 60_000)

  it("AC-17: with the app holding the secret, the origin's direct /api/products is 403 origin_locked, its direct /ready 200, and through the zone 200; the login limit reached through the zone logs Rate limit triggered with the ip the zone's /cdn-cgi/trace reports", async () => {
    const secret = secretInEnvFile()
    expect(secret === undefined ? 'no secret in .env' : 'set').toBe('set')
    await exec('flyctl', ['secrets', 'set', `${VAR}=${secret}`, '--app', FLY_APP], {
      timeout: 300_000,
    })
    // The app restarts with the secret: wait until the edge's requests are answered again.
    const deadline = Date.now() + 300_000
    let throughZone = 0
    while (Date.now() < deadline) {
      throughZone = await fetch(`${CDN}/api/products`, { signal: AbortSignal.timeout(10_000) })
        .then((r) => r.status)
        .catch(() => 0)
      if (throughZone === 200) break
      await new Promise((r) => setTimeout(r, 2000))
    }

    const direct = await fetch(`${ORIGIN}/api/products`, { signal: AbortSignal.timeout(10_000) })
    const directBody = (await direct.json().catch(() => ({}))) as { error?: { code?: string } }
    const ready = await fetch(`${ORIGIN}/ready`, { signal: AbortSignal.timeout(10_000) })
    expect([throughZone, direct.status, directBody.error?.code, ready.status]).toEqual([
      200,
      403,
      'origin_locked',
      200,
    ])

    const trace = await (await fetch(`${CDN}/cdn-cgi/trace`)).text()
    const ip = /^ip=(.+)$/m.exec(trace)?.[1]?.trim()
    // CSRF is on by default: a login without the pair is 403 csrf.invalid and never reaches the limiter.
    const issued = await fetch(`${CDN}/api/csrf`, { signal: AbortSignal.timeout(10_000) })
    const csrf = ((await issued.json().catch(() => ({}))) as { data?: { token?: string } }).data
      ?.token
    expect([issued.status, typeof csrf]).toEqual([200, 'string'])
    let limited = false
    for (let i = 0; i < 60 && !limited; i += 1) {
      const res = await fetch(`${CDN}/api/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf!,
          cookie: `nymbal.csrf=${csrf}`,
        },
        body: JSON.stringify({
          email: 'nobody@cloudflare-live.example',
          password: 'wrong-password',
        }),
      })
      await res.arrayBuffer()
      limited = res.status === 429
    }
    const logs = await exec('flyctl', ['logs', '--app', FLY_APP, '--no-tail'], {
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    const triggered = logs.stdout
      .split('\n')
      .filter((line) => line.includes('Rate limit triggered'))

    expect(limited).toBe(true)
    expect(
      ip === undefined ? 'no ip in /cdn-cgi/trace' : triggered.some((l) => l.includes(ip)),
    ).toBe(true)
  }, 900_000)
})
