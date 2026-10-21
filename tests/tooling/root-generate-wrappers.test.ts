import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// P2-06 AC-3: the root stub `scripts/generate-wrappers.ts` is gone, and nothing still names it. The real generator is
// packages/react/scripts/generate-wrappers.ts; a package.json script runs in its own package's directory, so a script
// in packages/react that says `scripts/generate-wrappers.ts` names the real one, not the stub. Workflows run at the
// repository root unless a step sets `working-directory`.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const STUB = resolve(REPO, 'scripts/generate-wrappers.ts')
const REAL = resolve(REPO, 'packages/react/scripts/generate-wrappers.ts')
const MENTION = /(?:[\w.@-]+\/)*generate-wrappers\.ts/g

function tracked(...patterns: string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...patterns], { cwd: REPO, encoding: 'utf8' })
    .split('\0')
    .filter((p) => p !== '')
}

interface Mention {
  where: string
  path: string
}

/** Every generate-wrappers.ts a package.json script mentions, resolved from its package's directory. */
function scriptMentions(): Mention[] {
  const found: Mention[] = []
  for (const manifest of tracked('package.json', '**/package.json')) {
    const pkg = JSON.parse(readFileSync(join(REPO, manifest), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const dir = dirname(join(REPO, manifest))
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      for (const mention of command.match(MENTION) ?? []) {
        found.push({ where: `${manifest} scripts.${name}: ${command}`, path: resolve(dir, mention) })
      }
    }
  }
  return found
}

/** Every generate-wrappers.ts a workflow line mentions, resolved from the repository root. */
function workflowMentions(): Mention[] {
  const found: Mention[] = []
  for (const workflow of tracked('.github/workflows/*.yml', '.github/workflows/*.yaml')) {
    readFileSync(join(REPO, workflow), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const mention of line.match(MENTION) ?? []) {
          found.push({ where: `${workflow}:${i + 1}: ${line.trim()}`, path: resolve(REPO, mention) })
        }
      })
  }
  return found
}

describe('P2-06 AC-3: the root generate-wrappers stub is deleted', () => {
  it('AC-3: scripts/generate-wrappers.ts does not exist, and no package.json script or workflow names it', () => {
    expect(existsSync(STUB), 'scripts/generate-wrappers.ts still exists').toBe(false)
    const scripts = scriptMentions()
    const naming = [...scripts, ...workflowMentions()].filter((m) => m.path === STUB)
    expect(naming.map((m) => m.where)).toEqual([])
    // The scan reads something: packages/react's own scripts name the real generator, which is not the stub.
    expect(scripts.filter((m) => m.path === REAL).length).toBeGreaterThan(0)
  })
})
