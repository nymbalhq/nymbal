import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// AC-12: the React wrapper generator (`packages/react/scripts/generate-wrappers.ts`, what `pnpm build` runs in
// packages/react) leaves `src/generated/manifest.json` byte-identical when the source hash is unchanged. The
// generator writes beside its own script, so it runs on a copy of the package in a temporary directory (its
// node_modules linked, not copied): the checkout's tracked manifest is never written.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const PACKAGE = join(REPO, 'packages/react')
const MANIFEST = 'src/generated/manifest.json'
const WRAPPERS = 'src/generated/wrappers.tsx'

const created: string[] = []
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

function copyPackage(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-generate-')))
  created.push(dir)
  const copy = join(dir, 'react')
  cpSync(PACKAGE, copy, {
    recursive: true,
    filter: (src) => {
      const top = relative(PACKAGE, src).split(sep)[0]
      return top !== 'node_modules' && top !== 'dist'
    },
  })
  symlinkSync(join(PACKAGE, 'node_modules'), join(copy, 'node_modules'))
  return copy
}

function generate(cwd: string, ...args: string[]): { status: number | null; out: string } {
  const result = spawnSync(TSX, ['scripts/generate-wrappers.ts', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` }
}

describe('AC-12: the wrapper generator does not dirty the tree', () => {
  it('AC-12: with the source hash unchanged, generating leaves manifest.json byte-identical; a stale hash is still rewritten', () => {
    const copy = copyPackage()
    const manifestBefore = readFileSync(join(copy, MANIFEST))
    const wrappersBefore = readFileSync(join(copy, WRAPPERS))
    // The committed manifest is current, so the hash really is unchanged.
    const check = generate(copy, '--check')
    expect(check.status, check.out).toBe(0)

    const first = generate(copy)
    expect(first.status, first.out).toBe(0)
    expect(readFileSync(join(copy, MANIFEST)).equals(manifestBefore), first.out).toBe(true)
    expect(readFileSync(join(copy, WRAPPERS)).equals(wrappersBefore)).toBe(true)

    const second = generate(copy)
    expect(second.status, second.out).toBe(0)
    expect(readFileSync(join(copy, MANIFEST)).equals(manifestBefore)).toBe(true)

    // A manifest whose hash no longer matches the components must still be regenerated.
    const stale = { ...JSON.parse(manifestBefore.toString('utf8')), sourceHash: 'stale' }
    writeFileSync(join(copy, MANIFEST), JSON.stringify(stale, null, 2))
    expect(generate(copy, '--check').status).not.toBe(0)
    const regenerated = generate(copy)
    expect(regenerated.status, regenerated.out).toBe(0)
    const after = JSON.parse(readFileSync(join(copy, MANIFEST), 'utf8')) as { sourceHash: string }
    expect(after.sourceHash).toBe(JSON.parse(manifestBefore.toString('utf8')).sourceHash)
    expect(generate(copy, '--check').status).toBe(0)
  })
})
