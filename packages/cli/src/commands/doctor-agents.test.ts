import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import repoConfig from '../../../../nymbal.config.js'
import {
  cliEnv,
  doctorJson,
  doctorLines,
  migratedSqlite,
  runCli,
  type CliRun,
} from '../../../../tests/support/doctor.js'

// AC-2: `nymbal doctor` says, before an agent arrives, whether UCP checkout is advertised without the legal links an
// agent shows the buyer. The line sits after `events` and before `trust proxy`, is a warning and never fails the run.
// Spawns the built CLI (`pnpm build` first) in a fresh project per case, on the repository's config.

const LINKS = [
  { type: 'privacy_policy', url: 'https://shop.example/privacy' },
  { type: 'terms_of_service', url: 'https://shop.example/terms' },
]

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nymbal-doctor-agents-'))
})
afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

/**
 * The repository's config on the default stores, with `agents.ucp` as given (absent, the repo's: no links) and the
 * other `agents` blocks as given.
 */
function rawConfig(
  ucp?: { enabled: boolean; links: typeof LINKS },
  agents?: Record<string, unknown>,
) {
  return {
    ...repoConfig,
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    ...((ucp !== undefined || agents !== undefined) && {
      agents: { ...(ucp !== undefined && { ucp }), ...agents },
    }),
  }
}

/** `nymbal doctor` (text, then `--json`) in a fresh project for the config, with no public URL set. */
async function doctor(
  ucp?: {
    enabled: boolean
    links: typeof LINKS
  },
  agents?: Record<string, unknown>,
): Promise<{ text: CliRun; json: CliRun }> {
  const project = mkdtempSync(join(dir, 'project-'))
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'test-store', private: true, type: 'module' })}\n`,
  )
  writeFileSync(
    join(project, 'nymbal.config.ts'),
    `export default ${JSON.stringify(rawConfig(ucp, agents), null, 2)}\n`,
  )
  const sqlitePath = join(project, 'nymbal.db')
  await migratedSqlite(sqlitePath)
  const env = cliEnv({
    NYMBAL_SQLITE_PATH: sqlitePath,
    NODE_ENV: undefined,
    NYMBAL_PUBLIC_URL: undefined,
  })
  return {
    text: await runCli(['doctor'], { cwd: project, env }),
    json: await runCli(['doctor', '--json'], { cwd: project, env }),
  }
}

describe('AC-2: nymbal doctor reports how ready the agent surfaces are', () => {
  it('AC-2: the repository config (no links) exits 0 with a warn agents line naming privacy_policy, terms_of_service and agents.ucp.links, degraded in --json, between events and trust proxy', async () => {
    const { text, json } = await doctor()
    const lines = doctorLines(text.out)
    const names = lines.map((l) => l.name)
    const line = lines.find((l) => l.name === 'agents')

    expect(names.indexOf('agents')).toBeGreaterThan(names.indexOf('events'))
    expect(names.indexOf('agents')).toBeLessThan(names.indexOf('trust proxy'))
    expect(names.slice(names.indexOf('events'), names.indexOf('trust proxy') + 1)).toEqual([
      'events',
      'agents',
      'trust proxy',
    ])
    expect(
      {
        status: line?.status,
        privacy: line?.detail.includes('privacy_policy'),
        terms: line?.detail.includes('terms_of_service'),
        key: line?.detail.includes('agents.ucp.links'),
      },
      text.out.slice(-3000),
    ).toEqual({ status: 'warn', privacy: true, terms: true, key: true })
    const checked = doctorJson(json.stdout).checks.find((c) => c.name === 'agents')
    expect(checked?.status).toBe('degraded')
    // The text and --json forms are one check: the same detail, its status printed as warn.
    expect(checked?.detail).toBe(line?.detail)
    expect([text.code, json.code]).toEqual([0, 0])
  }, 60_000)

  it('AC-2: with a privacy_policy and a terms_of_service link the agents line is ok, and doctor still exits 0', async () => {
    const warned = await doctor()
    const linked = await doctor({ enabled: true, links: LINKS })
    const status = (run: CliRun) => doctorLines(run.out).find((l) => l.name === 'agents')?.status

    expect([status(warned.text), status(linked.text)], linked.text.out.slice(-3000)).toEqual([
      'warn',
      'ok',
    ])
    expect(linked.text.code).toBe(0)
  }, 90_000)

  it('AC-2: with agents.ucp.enabled false the line is ok, its detail starting "ucp off"', async () => {
    const { text } = await doctor({ enabled: false, links: [] })
    const line = doctorLines(text.out).find((l) => l.name === 'agents')

    expect(
      { status: line?.status, off: line?.detail.startsWith('ucp off') },
      text.out.slice(-3000),
    ).toEqual({ status: 'ok', off: true })
    expect(text.code).toBe(0)
  }, 60_000)
})

describe('AC-11: nymbal doctor names what MCP withholds and what the assistant masks', () => {
  const DEFAULTS =
    '; customer fields: mcp withholds email, phone, address, postcode; assistant masks email, phone, address, postcode'
  const NOTHING = '; customer fields: mcp withholds nothing; assistant masks nothing'

  it('AC-11: on the repository config the agents line ends with the default clause, --json holds the same detail, and doctor exits 0', async () => {
    const { text, json } = await doctor()
    const line = doctorLines(text.out).find((l) => l.name === 'agents')
    const checked = doctorJson(json.stdout).checks.find((c) => c.name === 'agents')

    expect(line?.detail.slice(-DEFAULTS.length), text.out.slice(-3000)).toBe(DEFAULTS)
    expect(checked?.detail).toBe(line?.detail)
    expect([text.code, json.code]).toEqual([0, 0])
  }, 60_000)

  it('AC-11: with agents.mcp.withhold [] and agents.assistant.mask [] the agents line ends "mcp withholds nothing; assistant masks nothing", in text and --json alike, with the same status and exit code as the repository config', async () => {
    const repo = await doctor()
    const { text, json } = await doctor(undefined, {
      mcp: { withhold: [] },
      assistant: { mask: [] },
    })
    const line = doctorLines(text.out).find((l) => l.name === 'agents')
    const checked = doctorJson(json.stdout).checks.find((c) => c.name === 'agents')
    const before = doctorLines(repo.text.out).find((l) => l.name === 'agents')

    expect(line?.detail.slice(-NOTHING.length), text.out.slice(-3000)).toBe(NOTHING)
    expect(checked?.detail).toBe(line?.detail)
    expect([line?.status, text.code, json.code]).toEqual([
      before?.status,
      repo.text.code,
      repo.json.code,
    ])
  }, 90_000)
})
