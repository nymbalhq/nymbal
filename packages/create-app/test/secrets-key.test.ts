import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../src/index.js'

// AC-9: `create-nymbal-app` writes a fresh NYMBAL_SECRETS_KEY (32 bytes, canonical base64) into `.env` and never into
// `.env.example`; two scaffolds of the same answers differ only in `.env`'s generated lines. The scaffold is read from
// scaffold/templates (`pnpm build` first).

const argv = (...args: string[]): string[] => ['node', 'create-nymbal-app', ...args]
const GENERATED = new Set(['NYMBAL_SECRETS_KEY', 'NYMBAL_ADMIN_PASSWORD'])
const scratch: string[] = []
const originalCwd = process.cwd()
const savedUa = process.env['npm_config_user_agent']
let stdoutSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  process.env['npm_config_user_agent'] = 'pnpm/9.12.3 npm/? node/v22.23.3 darwin arm64'
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(() => {
  stdoutSpy.mockRestore()
  process.chdir(originalCwd)
  if (savedUa === undefined) delete process.env['npm_config_user_agent']
  else process.env['npm_config_user_agent'] = savedUa
})

afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

function dotEnvValue(source: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, 'm').exec(source)
  return match?.[1]?.replace(/^(['"])(.*)\1$/, '$2')
}

/** `.env` without the lines whose values are generated per project. */
function fixedLines(source: string): string[] {
  return source
    .split('\n')
    .filter((line) => !GENERATED.has(/^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1] ?? ''))
}

function filesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else out.push(relative(root, path))
    }
  }
  walk(root)
  return out.sort()
}

/** Scaffolds `shop` with --yes (nothing installed or run) in a fresh directory; returns the project directory. */
async function scaffoldOnce(): Promise<string> {
  const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'settings-scaffold-key-')))
  scratch.push(cwd)
  process.chdir(cwd)
  await main(argv('shop', '--yes'), { run: async () => undefined })
  return join(cwd, 'shop')
}

describe('AC-9: every scaffold gets its own secrets key', () => {
  it("AC-9: .env holds NYMBAL_SECRETS_KEY as 32 bytes of base64, two scaffolds' keys differ, .env.example does not name it, and nothing else differs but .env's generated lines", async () => {
    const a = await scaffoldOnce()
    const b = await scaffoldOnce()
    const keys = [a, b].map((dir) =>
      dotEnvValue(readFileSync(join(dir, '.env'), 'utf8'), 'NYMBAL_SECRETS_KEY'),
    )

    for (const key of keys) {
      expect(key, '.env names NYMBAL_SECRETS_KEY').toBeDefined()
      const bytes = Buffer.from(key!, 'base64')
      expect(bytes.length).toBe(32)
      expect(bytes.toString('base64')).toBe(key)
    }
    expect(keys[0]).not.toBe(keys[1])
    for (const dir of [a, b]) {
      expect(existsSync(join(dir, '.env.example'))).toBe(true)
      expect(readFileSync(join(dir, '.env.example'), 'utf8')).not.toContain('NYMBAL_SECRETS_KEY')
    }

    expect(filesUnder(a)).toEqual(filesUnder(b))
    const differing = filesUnder(a).filter(
      (rel) => rel !== '.env' && !readFileSync(join(a, rel)).equals(readFileSync(join(b, rel))),
    )
    expect(differing).toEqual([])
    expect(fixedLines(readFileSync(join(a, '.env'), 'utf8'))).toEqual(
      fixedLines(readFileSync(join(b, '.env'), 'utf8')),
    )
  }, 60_000)
})
