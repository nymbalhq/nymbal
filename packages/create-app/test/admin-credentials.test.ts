import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as Clack from '@clack/prompts'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/index.js'

// AC-12: create-app writes `.env` with the admin email and a random password before it seeds, passes both to the seed
// explicitly, and prints the admin URL, the email and the password. The scaffold is read from scaffold/templates, so
// run `pnpm build` first.

const printed = vi.hoisted(() => ({ text: [] as string[] }))

vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof Clack>()
  const record = (message?: unknown, title?: unknown) => {
    printed.text.push(`${String(title ?? '')}\n${String(message ?? '')}`)
  }
  return {
    ...actual,
    intro: record,
    outro: record,
    note: record,
    cancel: record,
    log: {
      ...actual.log,
      message: record,
      info: record,
      success: record,
      step: record,
      warn: record,
      warning: record,
      error: record,
    },
  }
})

interface Run {
  cmd: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv | undefined
  /** The project's `.env` as it stood when the command ran; null when it did not exist. */
  dotEnvAtRun: string | null
}

const argv = (...args: string[]): string[] => ['node', 'create-nymbal-app', ...args]
const scratch: string[] = []
const originalCwd = process.cwd()
const saved = {
  ua: process.env['npm_config_user_agent'],
  password: process.env['NYMBAL_ADMIN_PASSWORD'],
}
let stdoutSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  printed.text.length = 0
  process.env['npm_config_user_agent'] = 'pnpm/9.12.3 npm/? node/v22.23.3 darwin arm64'
  process.env['NYMBAL_ADMIN_PASSWORD'] = 'foo'
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    printed.text.push(String(chunk))
    return true
  })
})

afterEach(() => {
  stdoutSpy.mockRestore()
  process.chdir(originalCwd)
  for (const [key, value] of [
    ['npm_config_user_agent', saved.ua],
    ['NYMBAL_ADMIN_PASSWORD', saved.password],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

function dotEnvValue(source: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm').exec(source)
  return match?.[1]?.replace(/^(['"])(.*)\1$/, '$2')
}

/** Scaffolds `shop` with --yes in a fresh directory; returns what ran, the final `.env` and everything printed. */
async function scaffoldOnce(): Promise<{ runs: Run[]; dotEnv: string; output: string }> {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'admin-credentials-')))
  scratch.push(cwd)
  process.chdir(cwd)
  printed.text.length = 0
  const runs: Run[] = []
  const run = async (
    cmd: string,
    args: string[],
    dir: string,
    env?: NodeJS.ProcessEnv,
  ): Promise<void> => {
    const path = join(dir, '.env')
    runs.push({
      cmd,
      args: [...args],
      cwd: dir,
      env,
      dotEnvAtRun: existsSync(path) ? readFileSync(path, 'utf8') : null,
    })
  }
  await main(argv('shop', '--yes'), { run })
  const path = join(cwd, 'shop', '.env')
  expect(existsSync(path), '.env written in the project').toBe(true)
  return { runs, dotEnv: readFileSync(path, 'utf8'), output: printed.text.join('\n') }
}

describe('AC-12: the admin credentials reach .env, the seed and the outro', () => {
  it('AC-12: .env holds the admin email and a random base64url password of at least 22 chars, written before the seed; the seed env and the outro carry the same password, not the shell value', async () => {
    const { runs, dotEnv, output } = await scaffoldOnce()

    const email = dotEnvValue(dotEnv, 'NYMBAL_ADMIN_EMAIL')
    const password = dotEnvValue(dotEnv, 'NYMBAL_ADMIN_PASSWORD')
    expect(email).toBe('admin@nymbal.local')
    expect(password).toMatch(/^[A-Za-z0-9_-]{22,}$/)
    expect(password).not.toBe('foo')
    expect(password!.length).toBeGreaterThanOrEqual(22)

    const seed = runs.find(
      (r) => /\bnymbal\b/.test([r.cmd, ...r.args].join(' ')) && r.args.includes('seed'),
    )
    expect(
      seed,
      `no seed run among ${JSON.stringify(runs.map((r) => [r.cmd, ...r.args].join(' ')))}`,
    ).toBeDefined()
    expect(seed!.dotEnvAtRun, '.env must exist before the seed runs').not.toBeNull()
    expect(dotEnvValue(seed!.dotEnvAtRun!, 'NYMBAL_ADMIN_PASSWORD')).toBe(password)
    expect(seed!.env?.['NYMBAL_ADMIN_PASSWORD']).toBe(password)
    expect(seed!.env?.['NYMBAL_ADMIN_EMAIL']).toBe(email)

    expect(output).toContain('http://localhost:3001/admin/')
    expect(output).toContain(email)
    expect(output).toContain(password)
  }, 60_000)

  it('AC-12: two scaffolds get different passwords', async () => {
    const first = dotEnvValue((await scaffoldOnce()).dotEnv, 'NYMBAL_ADMIN_PASSWORD')
    const second = dotEnvValue((await scaffoldOnce()).dotEnv, 'NYMBAL_ADMIN_PASSWORD')
    expect(first).toMatch(/^[A-Za-z0-9_-]{22,}$/)
    expect(new Set([first, second]).size).toBeGreaterThan(1)
  }, 60_000)
})
