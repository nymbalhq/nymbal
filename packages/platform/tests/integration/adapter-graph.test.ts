import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { kernelConfig } from '../support/kernel.js'

// AC-2 and the kernel half of AC-7, in a child process (fixtures/adapter-graph): createApp from the built dist, with a
// module.register() resolve hook recording every URL the process resolves. The configured providers load from their
// adapter packages and no other SDK is resolved; a missing package or SDK fails with adapter.package_missing and the
// install line for the running package manager; a broken SDK is rethrown as itself. Needs `pnpm build`.

const exec = promisify(execFile)
const CHILD = fileURLToPath(new URL('./fixtures/adapter-graph/child.mjs', import.meta.url))

const SDKS = { stripe: 'stripe', anthropic: '@anthropic-ai/sdk', smtp: 'nodemailer' } as const
const underPackage = (url: string, name: string): boolean => url.includes(`/node_modules/${name}/`)
const isSdkUrl = (url: string): boolean => Object.values(SDKS).some((sdk) => underPackage(url, sdk))
const isAdapterUrl = (url: string, name: string): boolean =>
  new RegExp(`/packages/adapters/[^/]+/${name}/`).test(url) && !url.includes('/node_modules/.pnpm/')

interface Outcome {
  started?: { payments: string; ai: string | null }
  error?: { name?: string; code?: string; message: string }
}

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adapters-graph-test-'))
  dirs.push(dir)
  return dir
}

/** The child's environment: no package-manager user agent and no Anthropic key unless a case sets them. */
function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env['npm_config_user_agent']
  delete env['ANTHROPIC_API_KEY']
  return env
}

async function run(
  config: NymbalConfig,
  opts: { hide?: string[]; poison?: string[]; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<{ urls: string[]; outcome: Outcome }> {
  const dir = scratch()
  const out = join(dir, 'resolved.txt')
  writeFileSync(out, '')
  const { stdout } = await exec(process.execPath, [CHILD, JSON.stringify(config)], {
    cwd: opts.cwd ?? dir,
    env: {
      ...baseEnv(),
      ...opts.env,
      ADAPTERS_GRAPH: JSON.stringify({ out, hide: opts.hide, poison: opts.poison }),
    },
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  const line = stdout.split('\n').find((l) => l.startsWith('ADAPTER-GRAPH-OUTCOME '))
  if (line === undefined) throw new Error(`the child printed no outcome:\n${stdout}`)
  return {
    urls: readFileSync(out, 'utf8').split('\n').filter(Boolean),
    outcome: JSON.parse(line.slice('ADAPTER-GRAPH-OUTCOME '.length)) as Outcome,
  }
}

function withStripe(config: NymbalConfig): NymbalConfig {
  return {
    ...config,
    commerce: {
      ...config.commerce,
      payments: {
        provider: 'stripe',
        config: { secretKey: 'sk_test_adapters_never_called', webhookSecret: 'whsec_adapters' },
      },
    },
  }
}

function withAnthropic(config: NymbalConfig): NymbalConfig {
  return {
    ...config,
    commerce: { ...config.commerce, ai: { provider: 'anthropic', config: { apiKey: 'k' } } },
  }
}

const INSTALL_STRIPE = '@nymbalhq/payments-stripe stripe'

describe('AC-2: the config names a provider, and only then does its package load', () => {
  it('AC-2: with native everywhere and ai none, createApp starts and no resolved URL is under stripe, @anthropic-ai/sdk or nodemailer', async () => {
    const { urls, outcome } = await run(kernelConfig('sqlite'))

    expect(urls.length).toBeGreaterThan(0)
    expect(urls.filter(isSdkUrl)).toEqual([])
    expect(outcome).toEqual({ started: { payments: 'native-stub', ai: null } })
  }, 90_000)

  it('AC-2: with payments stripe and ai anthropic (apiKey in the block), payments is stripe and ai anthropic, loaded from @nymbalhq/payments-stripe and @nymbalhq/ai-anthropic, and nodemailer is never resolved', async () => {
    const { urls, outcome } = await run(withAnthropic(withStripe(kernelConfig('sqlite'))))

    expect(outcome).toEqual({ started: { payments: 'stripe', ai: 'anthropic' } })
    expect(urls.filter((u) => isAdapterUrl(u, 'stripe')).length).toBeGreaterThan(0)
    expect(urls.filter((u) => isAdapterUrl(u, 'anthropic')).length).toBeGreaterThan(0)
    expect(urls.filter((u) => underPackage(u, SDKS.smtp))).toEqual([])
  }, 90_000)
})

describe('AC-7 (kernel half): a missing adapter package fails with the install line', () => {
  const AGENTS = [
    { agent: 'npm/10.9.2 node/v22.23.3 darwin arm64 workspaces/false', verb: 'npm install' },
    { agent: 'pnpm/9.15.4 npm/? node/v22.23.3 darwin arm64', verb: 'pnpm add' },
    { agent: 'yarn/4.6.0 npm/? node/v22.23.3 darwin arm64', verb: 'yarn add' },
    { agent: 'bun/1.2.2 npm/? node/v22.23.3 darwin arm64', verb: 'bun add' },
  ]

  function missing(outcome: Outcome, verb: string): string | null {
    const e = outcome.error
    if (e === undefined) return `started: ${JSON.stringify(outcome.started)}`
    if (e.code !== 'adapter.package_missing') return `${e.code}: ${e.message}`
    if (!e.message.includes(`${verb} ${INSTALL_STRIPE}`))
      return `no "${verb} ${INSTALL_STRIPE}": ${e.message}`
    if (!/\bpayments\b/.test(e.message)) return `slot not named: ${e.message}`
    return null
  }

  it('AC-7: with @nymbalhq/payments-stripe not installed, createApp fails adapter.package_missing with the install verb of the user agent it runs under', async () => {
    const config = withStripe(kernelConfig('sqlite'))
    const results = await Promise.all(
      AGENTS.map(async ({ agent, verb }) => {
        const { outcome } = await run(config, {
          hide: ['@nymbalhq/payments-stripe'],
          env: { npm_config_user_agent: agent },
        })
        return { agent, why: missing(outcome, verb) }
      }),
    )
    expect(results.filter((r) => r.why !== null)).toEqual([])
  }, 120_000)

  it('AC-7: with no user agent, the verb follows the lockfile in the project root, else npm install; a missing SDK is reported like a missing package, and an SDK that throws while loading is rethrown as itself', async () => {
    const config = withStripe(kernelConfig('sqlite'))
    const pnpmProject = scratch()
    writeFileSync(join(pnpmProject, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    const yarnProject = scratch()
    writeFileSync(join(yarnProject, 'yarn.lock'), '')
    const cases = [
      {
        label: 'pnpm lockfile',
        cwd: pnpmProject,
        hide: ['@nymbalhq/payments-stripe'],
        verb: 'pnpm add',
      },
      {
        label: 'yarn lockfile',
        cwd: yarnProject,
        hide: ['@nymbalhq/payments-stripe'],
        verb: 'yarn add',
      },
      {
        label: 'no lockfile',
        cwd: scratch(),
        hide: ['@nymbalhq/payments-stripe'],
        verb: 'npm install',
      },
      { label: 'sdk missing', cwd: scratch(), hide: ['stripe'], verb: 'npm install' },
    ]
    const results = await Promise.all([
      ...cases.map(async ({ label, cwd, hide, verb }) => {
        const { outcome } = await run(config, { cwd, hide })
        return { label, why: missing(outcome, verb) }
      }),
      // Only a missing package or SDK becomes package_missing; any other load error is rethrown unchanged.
      run(config, { poison: ['stripe'] }).then(({ outcome }) => {
        const e = outcome.error
        const why =
          e === undefined
            ? `started: ${JSON.stringify(outcome.started)}`
            : e.code === 'adapter.package_missing' ||
                !e.message.includes('adapters poisoned stripe')
              ? `not rethrown as itself: ${e.code}: ${e.message}`
              : null
        return { label: 'sdk throws while loading', why }
      }),
    ])
    expect(results.filter((r) => r.why !== null)).toEqual([])
  }, 120_000)
})
