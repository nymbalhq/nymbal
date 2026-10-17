import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Acceptance tests for P0-04 AC-6: `scripts/rename-scope.ts` run twice changes nothing the second time, and it
// never touches pnpm-lock.yaml or archive/. Interface: `tsx scripts/rename-scope.ts --root <dir>`, rewriting the
// git-tracked files of <dir>.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
// Built so that this file never contains the old scope literally (AC-1 scans every tracked file).
const OLD = ['@nymbal', '/'].join('')
const NEW = '@nymbalhq/'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
}

function runRename(root: string): { status: number | null; output: string } {
  const res = spawnSync('pnpm', ['exec', 'tsx', 'scripts/rename-scope.ts', '--root', root], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { status: res.status, output: `${res.stdout}\n${res.stderr}` }
}

function snapshot(root: string, files: string[]): Map<string, Buffer> {
  return new Map(files.map((f) => [f, readFileSync(join(root, f))]))
}

/** Fragments mixing the old scope, the new scope and brand names that must survive unchanged. */
const FRAGMENT = fc.constantFrom(
  OLD,
  NEW,
  '@nymbal',
  'nymbal',
  'nymbal.config.ts',
  'create-nymbal-app',
  '@nymbalhq',
  'sdk',
  'platform',
  '/',
  "'",
  '"',
  ' ',
  '\n',
  'import { x } from ',
  '`',
)

// Fixed seed: the generated mini repo is the same on every run.
const GENERATED = fc
  .sample(fc.array(FRAGMENT, { minLength: 1, maxLength: 60 }), { numRuns: 40, seed: 0x04_06 })
  .map((parts, i) => {
    const ext = ['ts', 'tsx', 'mjs', 'md', 'astro', 'yml', 'txt', 'sh'][i % 8]
    return { path: `gen/file-${i}.${ext}`, content: parts.join('') }
  })

const FIXED: Record<string, string> = {
  'package.json': `${JSON.stringify(
    {
      name: `${OLD}foo`,
      private: true,
      scripts: { dev: `pnpm --filter ${OLD}cli dev`, scaffold: 'create-nymbal-app' },
      dependencies: { [`${OLD}bar`]: 'workspace:*', [`${NEW}baz`]: 'workspace:*' },
    },
    null,
    2,
  )}\n`,
  'src/index.ts': `import { bar } from '${OLD}bar'\nimport type { Baz } from "${OLD}baz/types"\nexport { bar }\n`,
  'README.md': `# Foo\n\nInstall \`${OLD}foo\` and run \`nymbal dev\` with \`nymbal.config.ts\`.\n`,
}

const UNTOUCHED: Record<string, string> = {
  'pnpm-lock.yaml': `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '${OLD}bar':\n        specifier: workspace:*\n`,
  'archive/old-plan.md': `The old packages were \`${OLD}foo\` and \`${OLD}bar\`.\n`,
  'archive/nested/legacy.ts': `import { foo } from '${OLD}foo'\n`,
}

describe('AC-6: rename-scope.ts is idempotent and skips the lockfile and archive/', () => {
  let root: string
  let files: string[]
  let original: Map<string, Buffer>
  let first: { status: number | null; output: string }
  let afterFirst: Map<string, Buffer>
  let second: { status: number | null; output: string }
  let afterSecond: Map<string, Buffer>

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rename-scope-'))
    const all: Record<string, string> = {
      ...FIXED,
      ...UNTOUCHED,
      ...Object.fromEntries(GENERATED.map((g) => [g.path, g.content])),
    }
    for (const [path, content] of Object.entries(all)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    git(root, 'init', '-q')
    git(root, 'add', '-A')
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'mini repo')
    files = Object.keys(all).sort()

    original = snapshot(root, files)
    first = runRename(root)
    afterFirst = snapshot(root, files)
    second = runRename(root)
    afterSecond = snapshot(root, files)
  }, 120_000)

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('AC-6: the first run rewrites exactly the old scope to the new one in every non-exempt file', () => {
    expect(first.status, first.output).toBe(0)
    const wrong: string[] = []
    for (const path of [...Object.keys(FIXED), ...GENERATED.map((g) => g.path)]) {
      const before = original.get(path)?.toString('utf8') ?? ''
      const after = afterFirst.get(path)?.toString('utf8')
      // Property over every generated file: only `@nymbalhq/` changes; brand names and the new scope do not.
      if (after !== before.replaceAll(OLD, NEW)) wrong.push(path)
    }
    expect(wrong).toEqual([])
    // The fixture really exercised the rewrite.
    const changed = files.filter(
      (f) => !original.get(f)?.equals(afterFirst.get(f) ?? Buffer.alloc(0)),
    )
    expect(changed.length).toBeGreaterThanOrEqual(Object.keys(FIXED).length)
  })

  it('AC-6: the second run changes nothing (byte-identical)', () => {
    expect(second.status, second.output).toBe(0)
    const changed = files.filter(
      (f) => !afterFirst.get(f)?.equals(afterSecond.get(f) ?? Buffer.alloc(0)),
    )
    expect(changed).toEqual([])
  })

  it('AC-6: pnpm-lock.yaml and archive/ are untouched by either run', () => {
    expect(first.status, first.output).toBe(0)
    const touched = Object.keys(UNTOUCHED).filter(
      (f) =>
        !original.get(f)?.equals(afterFirst.get(f) ?? Buffer.alloc(0)) ||
        !original.get(f)?.equals(afterSecond.get(f) ?? Buffer.alloc(0)),
    )
    expect(touched).toEqual([])
  })
})
