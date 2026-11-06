import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as Clack from '@clack/prompts'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { main } from '../src/index.js'

// AC-12: create-app writes `.env` with the admin email and a random password before it seeds, passes both to the seed
// explicitly, and prints the admin URL, the email and the password. AC-11: no two stores share an admin email: the
// interactive run asks for it with a random address pre-filled, `--yes` takes `--admin-email` or draws a random one,
// and an address that is not one is refused. The scaffold is read from scaffold/templates, so run `pnpm build` first.

const printed = vi.hoisted(() => ({ text: [] as string[] }))

interface TextPrompt {
  message: string
  initialValue?: string
  validate?: (value: string) => unknown
}

/** The interactive run's answers: `adminEmail` is typed into the admin email prompt; undefined accepts its default. */
const prompts = vi.hoisted(() => ({
  adminEmail: undefined as string | undefined,
  text: [] as TextPrompt[],
}))

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
    text: async (opts: TextPrompt) => {
      prompts.text.push(opts)
      if (/email/i.test(opts.message)) return prompts.adminEmail ?? opts.initialValue
      return 'Shop'
    },
    select: async (opts: { initialValue?: unknown; options: Array<{ value: unknown }> }) =>
      opts.initialValue ?? opts.options[0]?.value,
    // Install is always declined: a real install would shell out.
    confirm: async (opts: { message: string; initialValue?: boolean }) =>
      /install/i.test(opts.message) ? false : (opts.initialValue ?? false),
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
/** The address a scaffold draws when none is given: eight base32 characters. */
const RANDOM_ADMIN_EMAIL = /^admin-[a-z2-7]{8}@nymbal\.local$/
const scratch: string[] = []
const originalCwd = process.cwd()
const saved = {
  ua: process.env['npm_config_user_agent'],
  password: process.env['NYMBAL_ADMIN_PASSWORD'],
}
let stdoutSpy: MockInstance<typeof process.stdout.write>

beforeEach(() => {
  printed.text.length = 0
  prompts.text.length = 0
  prompts.adminEmail = undefined
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

async function freshDir(): Promise<string> {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'admin-credentials-')))
  scratch.push(cwd)
  return cwd
}

function dotEnvValue(source: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm').exec(source)
  return match?.[1]?.replace(/^(['"])(.*)\1$/, '$2')
}

/**
 * Runs create-nymbal-app with `args` (default `shop --yes`) in a fresh directory; returns what ran, the `.env` of
 * `directory` and everything printed.
 */
async function scaffoldOnce(
  args: string[] = ['shop', '--yes'],
  directory = 'shop',
): Promise<{ runs: Run[]; dotEnv: string; output: string }> {
  const cwd = await freshDir()
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
  await main(argv(...args), { run })
  const path = join(cwd, directory, '.env')
  expect(existsSync(path), '.env written in the project').toBe(true)
  return { runs, dotEnv: readFileSync(path, 'utf8'), output: printed.text.join('\n') }
}

describe('AC-12: the admin credentials reach .env, the seed and the outro', () => {
  it('AC-12: .env holds the admin email and a random base64url password of at least 22 chars, written before the seed; the seed env and the outro carry the same password, not the shell value', async () => {
    const { runs, dotEnv, output } = await scaffoldOnce()

    const email = dotEnvValue(dotEnv, 'NYMBAL_ADMIN_EMAIL')
    const password = dotEnvValue(dotEnv, 'NYMBAL_ADMIN_PASSWORD')
    expect(email).toMatch(RANDOM_ADMIN_EMAIL)
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

/** The seed run among `runs`. */
function seedOf(runs: Run[]): Run | undefined {
  return runs.find(
    (r) => /\bnymbal\b/.test([r.cmd, ...r.args].join(' ')) && r.args.includes('seed'),
  )
}

/** The admin email of one scaffold as `.env`, the seed's environment and the outro carry it. */
function emailsOf(result: { runs: Run[]; dotEnv: string; output: string }) {
  const email = dotEnvValue(result.dotEnv, 'NYMBAL_ADMIN_EMAIL')
  return {
    email,
    seed: seedOf(result.runs)?.env?.['NYMBAL_ADMIN_EMAIL'],
    printed: email !== undefined && result.output.includes(email),
  }
}

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`)
  }
}

describe('AC-11: no two scaffolds share an admin email', () => {
  it('AC-11: `--yes --name s1` and `--yes --name s2` write different admin emails, neither admin@nymbal.local, each admin-<8 base32>@nymbal.local, each the one the seed and the outro carry', async () => {
    const first = emailsOf(await scaffoldOnce(['--yes', '--name', 's1'], 's1'))
    const second = emailsOf(await scaffoldOnce(['--yes', '--name', 's2'], 's2'))

    expect(first.email).toMatch(RANDOM_ADMIN_EMAIL)
    expect(second.email).toMatch(RANDOM_ADMIN_EMAIL)
    expect(second.email).not.toBe(first.email)
    expect([first.email, second.email]).not.toContain('admin@nymbal.local')
    expect([first.seed, second.seed]).toEqual([first.email, second.email])
    expect([first.printed, second.printed]).toEqual([true, true])
  }, 60_000)

  it('AC-11: `--yes --name s3 --admin-email owner@shop.example`, and the `--admin-email=` form, write that address, which the seed and the outro carry', async () => {
    const spaced = emailsOf(
      await scaffoldOnce(['--yes', '--name', 's3', '--admin-email', 'owner@shop.example'], 's3'),
    )
    const joined = emailsOf(
      await scaffoldOnce(['--yes', '--name', 's3', '--admin-email=owner@shop.example'], 's3'),
    )

    expect(spaced).toEqual({
      email: 'owner@shop.example',
      seed: 'owner@shop.example',
      printed: true,
    })
    expect(joined).toEqual(spaced)
  }, 60_000)

  it('AC-11: the interactive run asks for the admin email after the store name: a typed me@shop.example is written, and accepting the default writes the pre-filled random address', async () => {
    prompts.adminEmail = 'me@shop.example'
    const typed = await scaffoldOnce([], 'shop')
    const typedPrompts = prompts.text.map((p) => p.message)
    prompts.adminEmail = undefined
    prompts.text.length = 0
    const accepted = await scaffoldOnce([], 'shop')
    const offered = prompts.text.find((p) => /admin email/i.test(p.message))?.initialValue

    expect(typedPrompts.findIndex((m) => /admin email/i.test(m))).toBe(
      typedPrompts.findIndex((m) => /store name/i.test(m)) + 1,
    )
    expect(dotEnvValue(typed.dotEnv, 'NYMBAL_ADMIN_EMAIL')).toBe('me@shop.example')
    expect(typed.output).toContain('me@shop.example')
    expect(offered).toMatch(RANDOM_ADMIN_EMAIL)
    expect(dotEnvValue(accepted.dotEnv, 'NYMBAL_ADMIN_EMAIL')).toBe(offered)
  }, 60_000)

  it("AC-11: the admin email prompt's validation accepts an address and refuses not-an-email, an empty value, a space and a second @", async () => {
    await scaffoldOnce([], 'shop')
    const validate = prompts.text.find((p) => /admin email/i.test(p.message))?.validate
    const candidates = [
      'me@shop.example',
      'not-an-email',
      '',
      'me @shop.example',
      'me@shop@example',
    ]

    expect(candidates.map((value) => validate?.(value) === undefined)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ])
  }, 60_000)

  for (const bad of ['not-an-email', '']) {
    it(`AC-11: \`--yes --name s4 --admin-email ${JSON.stringify(bad)}\` exits 1 naming --admin-email and creates no directory`, async () => {
      const cwd = await freshDir()
      process.chdir(cwd)
      const errors: string[] = []
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((chunk: string | Uint8Array) => {
          errors.push(String(chunk))
          return true
        })
      const exit = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
        throw new Exit(code === undefined || code === null ? undefined : Number(code))
      })
      const ran: string[] = []
      let outcome: unknown = null
      try {
        await main(argv('--yes', '--name', 's4', '--admin-email', bad), {
          run: async (cmd, args) => {
            ran.push([cmd, ...args].join(' '))
          },
        })
      } catch (error) {
        outcome = error
      } finally {
        exit.mockRestore()
        stderr.mockRestore()
      }

      expect(outcome instanceof Exit ? outcome.code : outcome).toBe(1)
      expect(errors.join('')).toContain('--admin-email')
      expect(existsSync(join(cwd, 's4'))).toBe(false)
      expect(ran).toEqual([])
    }, 60_000)
  }
})

const HELP_LINE = 'Problems or questions: https://github.com/nymbalhq/nymbal/issues'

describe('AC-12: the closing message ends with where to report a problem', () => {
  it('AC-12: --yes with the install, --yes --no-install and the interactive run each end with the issues URL, after the admin sign-in', async () => {
    const runs = [
      await scaffoldOnce(['shop', '--yes']),
      await scaffoldOnce(['shop', '--yes', '--no-install']),
      await scaffoldOnce([]),
    ]
    const lastLines = runs.map((r) => r.output.trimEnd().split('\n').at(-1))
    const afterSignIn = runs.map(
      (r) => r.output.lastIndexOf(HELP_LINE) > r.output.lastIndexOf('http://localhost:3001/admin/'),
    )

    expect(lastLines).toEqual([HELP_LINE, HELP_LINE, HELP_LINE])
    expect(afterSignIn).toEqual([true, true, true])
  }, 60_000)
})
