import { realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as Clack from '@clack/prompts'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { renovateEnablesAutomerge, STORE_PRESET } from '../../cli/src/update-check/decide.js'
import { main, renderRenovate } from '../src/index.js'

// Every new store gets a renovate.json extending Nymbal's store preset: one pull request per Nymbal release, and
// nothing that merges itself until the merchant extends the auto-updates preset. Each path through main() writes it.

const clack = vi.hoisted(() => ({ asked: 0 }))

vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof Clack>()
  return {
    ...actual,
    intro: () => {},
    outro: () => {},
    note: () => {},
    cancel: () => {},
    text: async (opts: { message: string; initialValue?: string }) => {
      clack.asked += 1
      return /email/i.test(opts.message) ? (opts.initialValue ?? 'admin@shop.example') : 'Shop'
    },
    select: async (opts: { initialValue?: unknown; options: Array<{ value: unknown }> }) => {
      clack.asked += 1
      return opts.initialValue ?? opts.options[0]?.value
    },
    // Install is always declined: a real install would shell out.
    confirm: async (opts: { message: string; initialValue?: boolean }) => {
      clack.asked += 1
      return /install/i.test(opts.message) ? false : (opts.initialValue ?? false)
    },
  }
})

const scratch: string[] = []
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true })
})

describe('AC-12: every path through main() writes renovate.json, and the old switch is gone', () => {
  const originalCwd = process.cwd()
  const originalUa = process.env['npm_config_user_agent']
  afterEach(() => {
    process.chdir(originalCwd)
    if (originalUa === undefined) delete process.env['npm_config_user_agent']
    else process.env['npm_config_user_agent'] = originalUa
  })

  const PATHS: Array<[string, string[]]> = [
    ['--yes', ['shop', '--yes']],
    ['--yes --no-install', ['shop', '--yes', '--no-install']],
    ['interactive, install declined', []],
  ]

  for (const [path, args] of PATHS) {
    it(`AC-12: ${path}: renovate.json is renderRenovate(), two-space JSON extending only the store preset with automerge off, and nymbal.config.ts has no autoUpdates`, async () => {
      process.env['npm_config_user_agent'] = 'pnpm/10.18.0 npm/? node/v26.12.1 darwin arm64'
      const cwd = realpathSync(await mkdtemp(join(tmpdir(), 'renovate-')))
      scratch.push(cwd)
      process.chdir(cwd)
      clack.asked = 0
      await main(['node', 'create-nymbal-app', ...args], { run: async () => {} })

      const project = join(cwd, 'shop')
      const written = await readFile(join(project, 'renovate.json'), 'utf8').catch(() => null)
      expect(written, `${path}: no renovate.json`).not.toBeNull()
      expect(written).toBe(renderRenovate())
      const parsed = JSON.parse(written!) as { extends?: unknown }
      expect(written).toBe(`${JSON.stringify(parsed, null, 2)}\n`)
      expect(parsed.extends).toEqual([STORE_PRESET])
      expect(renovateEnablesAutomerge(parsed)).toBe(false)

      const config = await readFile(join(project, 'nymbal.config.ts'), 'utf8')
      expect(config).not.toContain('autoUpdates')
      expect(clack.asked > 0, `${path}: prompted`).toBe(args.length === 0)
    }, 60_000)
  }
})
