import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import repoConfig from '../../../../nymbal.config.js'
import { formatDoctorReport } from './doctor-report.js'
import { cliEnv, closedPort, doctorLines, runCli } from '../../../../tests/support/doctor.js'

// AC-6 (b): no secret is ever printed, by the text or the `--json` formatting, while every check is named and each
// URL shows as `scheme://host:port/db`.

const secretArb = fc.stringMatching(/^[A-Za-z0-9]{16,28}$/)
const statusArb = fc.constantFrom(
  'ok' as const,
  'healthy' as const,
  'degraded' as const,
  'down' as const,
)

const caseArb = fc.record({
  pgUser: secretArb.map((s) => `u${s}`),
  pgPassword: secretArb.map((s) => `pw${s}`),
  pgQuery: secretArb.map((s) => `q${s}`),
  redisPassword: secretArb.map((s) => `rp${s}`),
  stripeKey: secretArb.map((s) => `sk_live_${s}`),
  smtpPassword: secretArb.map((s) => `smtp${s}`),
  s3Secret: secretArb.map((s) => `s3${s}`),
  statuses: fc.array(statusArb, { minLength: 6, maxLength: 6 }),
})

type Case = typeof caseArb extends fc.Arbitrary<infer T> ? T : never

const PG_AT = 'db.internal:5432'
const REDIS_AT = 'cache.internal:6380'

function made(c: Case) {
  const postgresUrl = `postgres://${c.pgUser}:${c.pgPassword}@${PG_AT}/shop?sslmode=require&sslpassword=${c.pgQuery}`
  const redisUrl = `redis://:${c.redisPassword}@${REDIS_AT}/0`
  const details = [
    `connect ECONNREFUSED ${postgresUrl}`,
    `${redisUrl} timed out after 5000 ms`,
    `Invalid API Key provided: ${c.stripeKey}`,
    `535 authentication failed for shop@example.com with password ${c.smtpPassword}`,
    `SignatureDoesNotMatch for secret ${c.s3Secret}`,
    `failed: ${postgresUrl} and ${redisUrl}`,
  ]
  const names = [
    'command store',
    'primitive documentStore',
    'slot payments',
    'slot email',
    'primitive media',
    'migrations',
  ]
  const report = {
    checks: names.map((name, i) => ({ name, status: c.statuses[i]!, detail: details[i]! })),
  }
  const config = {
    ...repoConfig,
    infrastructure: {
      commandStore: 'postgres',
      documentStore: { provider: 'redis' },
      eventBus: { provider: 'in-process' },
      media: { provider: 's3' },
      redis: { url: redisUrl, prefix: 'nymbal' },
      s3: { bucket: 'shop-media', region: 'eu-west-2' },
    },
    commerce: {
      ...repoConfig.commerce,
      payments: { provider: 'stripe', config: { secretKey: c.stripeKey } },
      email: {
        provider: 'smtp',
        config: { host: 'smtp.example.com', user: 'shop', pass: c.smtpPassword },
      },
    },
  } as unknown as NymbalConfig
  const env: NodeJS.ProcessEnv = {
    DATABASE_URL: postgresUrl,
    REDIS_URL: redisUrl,
    STRIPE_SECRET_KEY: c.stripeKey,
    SMTP_PASS: c.smtpPassword,
    AWS_SECRET_ACCESS_KEY: c.s3Secret,
  }
  const secrets = [
    c.pgUser,
    c.pgPassword,
    c.pgQuery,
    c.redisPassword,
    c.stripeKey,
    c.smtpPassword,
    c.s3Secret,
  ]
  return { report, config, env, secrets, names }
}

const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('AC-6 (b): doctor prints no secret', () => {
  it('AC-6 (b): over generated reports whose details, config and environment carry secrets, the text and --json formats print none of them, and still print every check and each host:port', () => {
    fc.assert(
      fc.property(caseArb, (c) => {
        const { report, config, env, secrets, names } = made(c)
        const text = formatDoctorReport(report, { json: false, config, env })
        const json = formatDoctorReport(report, { json: true, config, env })

        for (const secret of secrets) {
          expect(text).not.toContain(secret)
          expect(json).not.toContain(secret)
        }
        expect(doctorLines(text).map((l) => l.name)).toEqual(names)
        expect(
          (JSON.parse(json) as { checks: Array<{ name: string }> }).checks.map((x) => x.name),
        ).toEqual(names)
        for (const at of [PG_AT, REDIS_AT]) {
          expect(text).toContain(at)
          expect(json).toContain(at)
        }
      }),
      { numRuns: 200 },
    )
  })

  it('AC-6 (b): a CLI sample with real secrets in .env: doctor and doctor --json print none of them and report the command store down', async () => {
    const project = mkdtempSync(join(tmpdir(), 'nymbal-doctor-secrets-'))
    dirs.push(project)
    const pgPassword = `pw${Date.now().toString(36)}Xq81LmZr`
    const pgQuery = `q${Date.now().toString(36)}Hy2Bv`
    const redisPassword = `rp${Date.now().toString(36)}Kd93Fz`
    const stripeKey = `sk_live_${Date.now().toString(36)}Wq0PsNc7Tm`
    const pgPort = await closedPort()
    const redisPort = await closedPort()
    writeFileSync(
      join(project, '.env'),
      [
        `DATABASE_URL=postgres://nymbal:${pgPassword}@127.0.0.1:${pgPort}/shop?sslpassword=${pgQuery}`,
        `REDIS_URL=redis://:${redisPassword}@127.0.0.1:${redisPort}/0`,
        `STRIPE_SECRET_KEY=${stripeKey}`,
        '',
      ].join('\n'),
    )
    const raw = {
      ...repoConfig,
      infrastructure: {
        commandStore: 'postgres',
        documentStore: { provider: 'redis' },
        eventBus: { provider: 'in-process' },
      },
      commerce: {
        ...repoConfig.commerce,
        payments: { provider: 'stripe', config: { secretKey: '__STRIPE__' } },
      },
    }
    // The config reads the key from the environment `.env` filled, as a project's does.
    const source = `export default ${JSON.stringify(raw, null, 2)}\n`.replace(
      '"__STRIPE__"',
      "process.env['STRIPE_SECRET_KEY']",
    )
    writeFileSync(join(project, 'nymbal.config.ts'), source)

    const text = await runCli(['doctor'], { cwd: project, env: cliEnv() })
    const json = await runCli(['doctor', '--json'], { cwd: project, env: cliEnv() })

    for (const secret of [pgPassword, pgQuery, redisPassword, stripeKey]) {
      expect(text.out).not.toContain(secret)
      expect(json.out).not.toContain(secret)
    }
    expect(doctorLines(text.out).find((l) => l.name === 'command store')?.status, text.out).toBe(
      'down',
    )
    expect(text.code).toBe(json.code)
  }, 60_000)
})
