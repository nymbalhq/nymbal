import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// AC-5: `nymbal --version` equals the version in packages/cli/package.json. It runs the built bin (run `pnpm build`
// first), from a directory unrelated to the repository so cwd cannot supply a version.

const CLI_ROOT = fileURLToPath(new URL('../', import.meta.url))
const BIN = resolve(CLI_ROOT, 'bin', 'nymbal.mjs')

interface CliManifest {
  version: string
  [key: string]: unknown
}

function readManifest(dir: string): CliManifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as CliManifest
}

const scratch = mkdtempSync(join(tmpdir(), 'nymbal-cli-version-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A user's shell environment: citty's logger (consola) prints nothing under Vitest's NODE_ENV=test or TEST=true. */
function userShellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
  delete env['NODE_ENV']
  delete env['TEST']
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
  return env
}

function runVersion(bin: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [bin, '--version'], {
    cwd: scratch,
    encoding: 'utf8',
    env: userShellEnv(),
    timeout: 30_000,
  })
  return { status: res.status, stdout: res.stdout.trim(), stderr: res.stderr }
}

describe('AC-5: nymbal --version reports the CLI package version', () => {
  it('AC-5: the built bin prints the version in packages/cli/package.json', () => {
    const res = runVersion(BIN)
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toBe(readManifest(CLI_ROOT).version)
  })

  it('AC-5: installed outside the monorepo, the bin prints its own package.json version', () => {
    // The npm layout: <project>/node_modules/nymbal/{bin,dist,package.json}. The copy gets a version no other
    // package.json carries, so only the CLI's own manifest can produce it.
    const manifest = readManifest(CLI_ROOT)
    const probe = `${manifest.version}-probe.${process.pid}`
    const installed = join(scratch, 'project', 'node_modules', 'nymbal')
    mkdirSync(installed, { recursive: true })
    cpSync(join(CLI_ROOT, 'bin'), join(installed, 'bin'), { recursive: true })
    cpSync(join(CLI_ROOT, 'dist'), join(installed, 'dist'), { recursive: true })
    writeFileSync(
      join(installed, 'package.json'),
      JSON.stringify({ ...manifest, version: probe }, null, 2),
    )
    // Runtime dependencies resolve from the workspace's install of them.
    symlinkSync(join(CLI_ROOT, 'node_modules'), join(installed, 'node_modules'), 'dir')

    const res = runVersion(join(installed, 'bin', 'nymbal.mjs'))
    expect(res.status, res.stderr).toBe(0)
    expect(res.stdout).toBe(readManifest(installed).version)
    expect(res.stdout).not.toBe(manifest.version)
  })
})
