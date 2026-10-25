import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The React wrapper generator (`packages/react/scripts/generate-wrappers.ts`, what `pnpm build` runs in packages/react).
// AC-12: it leaves `src/generated/manifest.json` byte-identical when the source hash is unchanged. AC-2, the
// real-schema half: `check:generated` (`--check`) passes only while generating over the real element schemas equals
// the committed wrappers.tsx, so a hand edit fails it and generating puts the committed bytes back. The generator
// writes beside its own script, so it runs on one copy of the package in a temporary directory (its node_modules
// linked, not copied), shared by the cases, each of which leaves it as it found it: the checkout is never written.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const PACKAGE = join(REPO, 'packages/react')
const MANIFEST = 'src/generated/manifest.json'
const WRAPPERS = 'src/generated/wrappers.tsx'

const created: string[] = []
afterAll(() => {
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

let copy = ''
let check: { status: number | null; out: string } = { status: null, out: '' }

beforeAll(() => {
  copy = copyPackage()
  check = generate(copy, '--check')
}, 60_000)

describe('AC-12: the wrapper generator does not dirty the tree', () => {
  it('AC-12: with the source hash unchanged, generating leaves manifest.json byte-identical; a stale hash is still rewritten', () => {
    const manifestBefore = readFileSync(join(copy, MANIFEST))
    const wrappersBefore = readFileSync(join(copy, WRAPPERS))
    // The committed manifest is current, so the hash really is unchanged.
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

describe('AC-2: check:generated holds the committed wrappers to the element schemas', () => {
  it('AC-2: --check passes on the committed wrappers.tsx, fails once it is hand-edited, and generating restores the committed bytes', () => {
    const committed = join(PACKAGE, WRAPPERS)
    expect(check.status, check.out).toBe(0)

    appendFileSync(join(copy, WRAPPERS), '\nexport const handEdited = true\n')
    const drifted = generate(copy, '--check')
    expect(drifted.status, `--check passed a hand-edited wrappers.tsx:\n${drifted.out}`).not.toBe(0)

    const regenerated = generate(copy)
    expect(regenerated.status, regenerated.out).toBe(0)
    expect(readFileSync(join(copy, WRAPPERS), 'utf8')).toBe(readFileSync(committed, 'utf8'))
    expect(generate(copy, '--check').status).toBe(0)
  })
})
