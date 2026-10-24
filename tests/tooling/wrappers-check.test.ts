import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// AC-2, the real-schema half: `check:generated` (`generate-wrappers.ts --check`) passes only while `generateWrappers`
// over the real element schemas equals the committed wrappers.tsx, so wrappers cannot drift from the elements: a hand
// edit to wrappers.tsx fails the check, and generating puts the committed bytes back. The generator writes beside its
// own script, so it runs on a copy of the package (its node_modules linked), as tests/tooling/generate-wrappers.test.ts
// does; the checkout's tracked files are never written.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const PACKAGE = join(REPO, 'packages/react')
const WRAPPERS = 'src/generated/wrappers.tsx'

const created: string[] = []
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

function copyPackage(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-wrappers-check-')))
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

describe('AC-2: check:generated holds the committed wrappers to the element schemas', () => {
  it('AC-2: --check passes on the committed wrappers.tsx, fails once it is hand-edited, and generating restores the committed bytes', () => {
    const copy = copyPackage()
    const committed = join(PACKAGE, WRAPPERS)
    const check = generate(copy, '--check')
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
