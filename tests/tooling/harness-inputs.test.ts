// Reads: package.json, vitest.config.ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  changedFiles,
  declaredReads,
  HARNESS_PROJECTS,
  harnessInputTests,
  plan,
  type PlanInput,
} from '../../scripts/gate'
import { leftOut, listedProjects, vitestFilters, words } from './vitest-filters'

// A harness test file names, on `// Reads:` lines, the checkout files it reads or runs outside its imports. The gate
// finds the files whose globs match a change and hands them to the tests step beside the changed paths, in one Vitest
// run that also carries the base CI exports as GATE_BASE.

const created: string[] = []
afterAll(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-reads-')))
  created.push(dir)
  git(dir, 'init', '-q')
  return dir
}

function put(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

const asSet = (globs: string[] | undefined): string[] | undefined =>
  globs === undefined ? undefined : [...new Set(globs)].sort()

describe('AC-4: declaredReads reads every // Reads: line of a test file', () => {
  it('AC-4: globs on one line, unioned over several, none for nothing, undefined with no line at column 0', () => {
    expect(asSet(declaredReads("// Reads: a.json, scripts/*.ts\nimport 'x'\n"))).toEqual([
      'a.json',
      'scripts/*.ts',
    ])
    expect(
      asSet(declaredReads("// Reads: a.json\nimport 'x'\n\n// Reads: docs/**, a.json\nit()\n")),
    ).toEqual(['a.json', 'docs/**'])
    expect(declaredReads("// Reads: nothing\nimport 'x'\n")).toEqual([])
    expect(declaredReads("import 'x'\n")).toBeUndefined()
    expect(declaredReads("  // Reads: a.json\nimport 'x'\n")).toBeUndefined()
  })

  it('AC-4: nothing beside a glob, on one line or across two, is refused', () => {
    expect(() => declaredReads('// Reads: nothing, a.json\n')).toThrow(/nothing/)
    expect(() => declaredReads('// Reads: a.json\n// Reads: nothing\n')).toThrow(/nothing/)
  })

  it('AC-4: for any globs spread over any number of lines between code, the result is their union', () => {
    const glob = fc.constantFrom(
      '.github/workflows/ci.yml',
      '.github/workflows/*.yml',
      'scripts/*.ts',
      'docs/**',
      'mutation-ratchet.json',
      'tests/contracts/**',
    )
    fc.assert(
      fc.property(
        fc.array(fc.array(glob, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 4 }),
        (lines) => {
          const source = lines.map((l) => `// Reads: ${l.join(', ')}\nconst x = 1\n`).join('\n')
          expect(asSet(declaredReads(source))).toEqual([...new Set(lines.flat())].sort())
        },
      ),
    )
  })
})

describe('AC-4: harnessInputTests finds the harness test files whose globs match a change', () => {
  /** The live readers of the tree below and their globs: what a brute-force union is taken over. */
  const READERS: Record<string, string[]> = {
    'tests/tooling/a.test.ts': ['.github/workflows/*.yml'],
    'tests/tooling/b.test.ts': ['mutation-ratchet.json', 'scripts/x.ts', 'docs/**'],
    'tests/tooling/star.test.ts': ['scripts/*'],
    'tests/tooling/sub/n.test.ts': ['package.json'],
    'tests/architecture/e.test.ts': ['apps/admin/src/**'],
    'tests/architecture/f.test.ts': ['tests/contracts/**'],
    'tests/architecture/all.test.ts': ['**'],
    'tests/tooling/deep.test.ts': ['**/ci.yml'],
  }
  const ALL = 'tests/architecture/all.test.ts'
  const POOL = [
    '.github/workflows/ci.yml',
    '.github/workflows/nightly.yml',
    '.node-version',
    'mutation-ratchet.json',
    'scripts/x.ts',
    'scripts/sub/y.ts',
    'docs/a/b.md',
    'apps/admin/src/hooks/h.ts',
    'tests/contracts/suites/n.ts',
    'compose.yaml',
    'package.json',
    'README.md',
  ]
  let root = ''

  beforeAll(() => {
    root = scratch()
    const code = "import { it } from 'vitest'\n\nit('runs', () => {})\n"
    put(root, 'tests/tooling/a.test.ts', `// Reads: .github/workflows/*.yml\n${code}`)
    put(
      root,
      'tests/tooling/b.test.ts',
      `// Reads: mutation-ratchet.json\n${code}// Reads: scripts/x.ts, docs/**\n`,
    )
    put(root, 'tests/tooling/c.test.ts', `// Reads: nothing\n${code}`)
    put(root, 'tests/tooling/d.test.ts', code)
    put(root, 'tests/tooling/star.test.ts', `// Reads: scripts/*\n${code}`)
    put(root, 'tests/tooling/sub/n.test.ts', `// Reads: package.json\n${code}`)
    put(root, 'tests/architecture/e.test.ts', `// Reads: apps/admin/src/**\n${code}`)
    put(root, ALL, `// Reads: **\n${code}`)
    put(root, 'tests/tooling/deep.test.ts', `// Reads: **/ci.yml\n${code}`)
    // Never readers: deleted from the work tree, under fixtures/, not a test file, indented, or another project's.
    put(root, 'tests/tooling/gone.test.ts', `// Reads: compose.yaml\n${code}`)
    put(root, 'tests/architecture/fixtures/harness-inputs/x.test.ts', `// Reads: **\n${code}`)
    put(root, 'tests/tooling/fixtures/y.test.ts', `// Reads: compose.yaml\n${code}`)
    put(root, 'tests/tooling/helper.ts', '// Reads: compose.yaml\nexport const h = 1\n')
    put(root, 'tests/tooling/indented.test.ts', `  // Reads: compose.yaml\n${code}`)
    put(root, 'tests/e2e/z.test.ts', `// Reads: compose.yaml\n${code}`)
    for (const path of POOL) put(root, path, 'x\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'base')
    rmSync(join(root, 'tests/tooling/gone.test.ts'))
    // Untracked, and a reader all the same.
    put(root, 'tests/architecture/f.test.ts', `// Reads: tests/contracts/**\n${code}`)
  })

  /** The glob forms above, by hand: `*` within one segment, `**` across any, and a leading dot no different. */
  const asRegExp = (glob: string): RegExp =>
    new RegExp(
      `^${glob
        .split(/(\*\*\/|\*\*|\*)/)
        .map((part) =>
          part === '**/'
            ? '(?:.*/)?'
            : part === '**'
              ? '.*'
              : part === '*'
                ? '[^/]*'
                : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('')}$`,
    )
  const bruteForce = (changed: string[]): string[] =>
    Object.entries(READERS)
      .filter(([, globs]) => changed.some((path) => globs.some((g) => asRegExp(g).test(path))))
      .map(([file]) => file)
      .sort()

  it('AC-4: * stays within a directory and ** crosses; a deleted, fixture, non-test, indented or other-project file is never a reader', () => {
    expect(harnessInputTests(root, ['scripts/sub/y.ts'])).toEqual([ALL])
    expect(harnessInputTests(root, ['docs/a/b.md'])).toEqual([ALL, 'tests/tooling/b.test.ts'])
    expect(harnessInputTests(root, ['compose.yaml', 'README.md'])).toEqual([ALL])
    expect(harnessInputTests(root, ['tests/contracts/suites/n.ts'])).toEqual([
      ALL,
      'tests/architecture/f.test.ts',
    ])
    expect(
      harnessInputTests(root, ['scripts/x.ts', 'scripts/x.ts', 'mutation-ratchet.json']),
    ).toEqual([ALL, 'tests/tooling/b.test.ts', 'tests/tooling/star.test.ts'])
  })

  it('AC-4: ** takes dot-directories and dotfiles, at the start of a glob and after it', () => {
    expect(harnessInputTests(root, ['.node-version'])).toEqual([ALL])
    expect(harnessInputTests(root, ['.github/workflows/ci.yml'])).toEqual([
      ALL,
      'tests/tooling/a.test.ts',
      'tests/tooling/deep.test.ts',
    ])
    expect(harnessInputTests(root, ['.github/workflows/nightly.yml'])).toEqual([
      ALL,
      'tests/tooling/a.test.ts',
    ])
  })

  it('AC-4: for any subset of changed paths, the readers are the brute-force union, sorted and unique', () => {
    fc.assert(
      fc.property(fc.subarray(POOL), fc.subarray(POOL), (changed, again) => {
        expect(harnessInputTests(root, [...changed, ...again])).toEqual(
          bruteForce([...changed, ...again]),
        )
      }),
      { numRuns: 60 },
    )
  })
})

describe('AC-4: changedFiles can list both sides of a rename', () => {
  it('AC-4: after a committed move a→b and an uncommitted move b→c, renames: false lists a, b and c; the default call keeps git’s rename-detected list', () => {
    const root = scratch()
    put(root, 'a.txt', 'one\ntwo\nthree\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'base')
    const base = git(root, 'rev-parse', 'HEAD').trim()
    git(root, 'mv', 'a.txt', 'b.txt')
    git(root, 'commit', '-q', '-m', 'move')
    git(root, 'mv', 'b.txt', 'c.txt')

    expect(changedFiles(root, base, { renames: false })).toEqual(['a.txt', 'b.txt', 'c.txt'])
    const today = [
      ...git(root, 'diff', '--name-only', base).split('\n'),
      ...git(root, 'ls-files', '--others', '--exclude-standard').split('\n'),
    ].filter(Boolean)
    expect(changedFiles(root, base)).toEqual([...new Set(today)].sort())
  })
})

// ---- AC-5: the plan ----

const BASE = '0123456789abcdef0123456789abcdef01234567'
const KERNEL = 'packages/platform/src/services/cart-service.ts'
const KIT = 'packages/proof-kit/src/index.ts'
const PERF = 'packages/platform/tests/integration/search-performance.test.ts'
const TOOLING_READER = 'tests/tooling/ci-workflow.test.ts'
const ARCHITECTURE_READER = 'tests/architecture/node-pin.test.ts'

const testsCommand = (input: Partial<PlanInput>): string => {
  const step = plan({
    full: false,
    base: BASE,
    changed: [KERNEL],
    mutated: [],
    ...input,
  }).steps.find((s) => s.name === 'tests')
  if (step === undefined) throw new Error('no tests step')
  return step.command
}

/** The `NAME=value` words that start each `&&`-joined command, in order. */
const envWords = (command: string): Array<Array<[string, string]>> =>
  command.split(' && ').map((segment) => {
    const out: Array<[string, string]> = []
    for (const word of words(segment)) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(word)
      if (m === null) break
      out.push([m[1]!, m[2]!])
    }
    return out
  })

/** The positional arguments of the first command's `vitest related`: the paths it is handed. */
function relatedArgs(command: string): string[] {
  const argv = words(command.split(' && ')[0] ?? '')
  const at = argv.indexOf('related')
  if (at === -1 || argv[at - 1] !== 'vitest') return []
  const out: string[] = []
  for (let i = at + 1; i < argv.length; i++) {
    const word = argv[i]!
    if (word === '--project' || word === '--exclude' || word === '-t') i++
    else if (!word.startsWith('-')) out.push(word)
  }
  return out.sort()
}

describe('AC-5: the plain gate keeps a reader’s project and runs it in the same Vitest process', () => {
  it('AC-5: the projects a changed-mode step leaves out follow the readers, and a harness path keeps both as today', () => {
    const rows = [
      { label: 'tooling reader', changed: [KERNEL], readers: [TOOLING_READER] },
      {
        label: 'readers in both',
        changed: [KERNEL],
        readers: [TOOLING_READER, ARCHITECTURE_READER],
      },
      { label: 'no reader', changed: [KERNEL], readers: [] },
      { label: 'harness path', changed: [KERNEL, 'scripts/gate.ts'], readers: [TOOLING_READER] },
    ].map(({ label, changed, readers }) => ({
      label,
      left: leftOut(testsCommand({ changed, inputReaders: readers }), HARNESS_PROJECTS),
    }))
    expect(rows).toEqual([
      { label: 'tooling reader', left: ['architecture'] },
      { label: 'readers in both', left: [] },
      { label: 'no reader', left: [...HARNESS_PROJECTS].sort() },
      { label: 'harness path', left: [] },
    ])
  })

  it('AC-5: through vitest list, a tooling reader keeps the tooling project and leaves architecture out', async () => {
    const command = testsCommand({ inputReaders: [TOOLING_READER] })
    const { env, projects, excludes } = vitestFilters(command)
    const listed = await listedProjects(
      [...projects.flatMap((p) => ['--project', p]), ...excludes.flatMap((e) => ['--exclude', e])],
      env,
    )
    const every = await listedProjects([])
    expect(listed).toContain('tooling')
    expect(listed).not.toContain('architecture')
    expect(listed.length).toBeLessThan(every.length)
  }, 120_000)

  it('AC-5: one vitest related run names every related path and reader, with the test script’s filters, GATE_BASE first and the skip after it', () => {
    const related = [KERNEL, 'packages/platform/src/odd name.ts']
    const readers = [TOOLING_READER, 'tests/tooling/sentinel-select.test.ts']
    const command = testsCommand({ changed: related, relatedPaths: related, inputReaders: readers })

    expect(command.split(' && ')).toHaveLength(1)
    expect(relatedArgs(command)).toEqual([...new Set([...related, ...readers])].sort())
    const script = vitestFilters('pnpm run test')
    const step = vitestFilters(command)
    expect(step.projects).toEqual(script.projects)
    expect([...step.excludes].sort()).toEqual([...script.excludes, PERF].sort())
    expect(envWords(command)[0]).toEqual([
      ['GATE_BASE', BASE],
      ['NYMBAL_VITEST_SKIP_PROJECTS', 'architecture,tooling-slow'],
    ])
  })

  it('AC-5: the related paths default to the changed list', () => {
    const changed = [KERNEL, 'packages/sdk/src/client.ts']
    expect(relatedArgs(testsCommand({ changed, inputReaders: [] }))).toEqual([...changed].sort())
  })

  it('AC-5: every command of the plain gate’s tests step carries GATE_BASE=<base>, the kit chain and --rerun-red too; with no base none does', () => {
    const shapes: Array<{ label: string; input: Partial<PlanInput> }> = [
      { label: 'changed', input: { changed: [KERNEL] } },
      { label: 'changed, kit chain', input: { changed: [KIT] } },
      { label: 'all', input: { changed: ['package.json', KERNEL] } },
      {
        label: 'rerun-red',
        input: { rerun: { tests: [{ file: 'tests/tooling/gate.test.ts', name: 'a b' }] } },
      },
    ]
    const bases = shapes.map(({ label, input }) => ({
      label,
      bases: envWords(testsCommand(input)).map(
        (env) => env.find(([name]) => name === 'GATE_BASE')?.[1] ?? null,
      ),
    }))
    expect(bases.find((b) => b.label === 'changed, kit chain')?.bases).toHaveLength(2)
    expect(bases).toEqual(bases.map(({ label, bases: b }) => ({ label, bases: b.map(() => BASE) })))

    const noBase = shapes.map(({ input }) =>
      testsCommand({ ...input, noBase: true, base: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' }),
    )
    expect(noBase.filter((c) => c.includes('GATE_BASE='))).toEqual([])
  })
})

describe('AC-5: readers change no other command, and gate:full carries no GATE_BASE', () => {
  const READER_POOL = [
    TOOLING_READER,
    ARCHITECTURE_READER,
    'tests/tooling/mutation-ratchet.test.ts',
    'tests/architecture/scope-rename.test.ts',
  ]
  const CHANGE_SETS = [
    [KERNEL],
    ['package.json'],
    ['docs/notes.md'],
    ['scripts/gate.ts', KERNEL],
    [KIT],
    ['.github/workflows/nightly.yml'],
  ]

  const commands = (input: PlanInput): string[] =>
    plan(input).steps.map((s) => `${s.name}: ${s.command}`)

  const projectOf = (file: string): string =>
    file.startsWith('tests/architecture/') ? 'architecture' : 'tooling'

  it('AC-5: for any readers, the all, none and --rerun-red commands, every --harness all command and every gate:full command whose readers’ projects run anyway equal those with none; a gate:full that leaves a reader’s project out keeps it and changes nothing else; the plain ones carry GATE_BASE and gate:full’s do not', () => {
    fc.assert(
      fc.property(
        fc.subarray(READER_POOL, { minLength: 1 }),
        fc.constantFrom(...CHANGE_SETS),
        fc.constantFrom('plain', 'rerun', 'full', 'harness all'),
        (readers, changed, shape) => {
          const input: PlanInput = {
            full: shape === 'full' || shape === 'harness all',
            base: BASE,
            changed,
            mutated: [],
            ...(shape === 'harness all' ? { harness: 'all' as const } : {}),
            ...(shape === 'rerun'
              ? { rerun: { tests: [{ file: 'tests/tooling/gate.test.ts', name: 'a b' }] } }
              : {}),
          }
          // The plain gate's changed-mode run takes readers by design (the AC-5 tests above).
          const comparable =
            shape !== 'plain' ||
            changed.includes('package.json') ||
            changed.every((p) => p.endsWith('.md'))
          if (!comparable) return
          const testsOf = (cs: string[]): string =>
            (cs.find((c) => c.startsWith('tests: ')) ?? '').slice('tests: '.length)
          const othersOf = (cs: string[]): string[] => cs.filter((c) => !c.startsWith('tests: '))
          const without = commands({ ...input, inputReaders: [] })
          const withReaders = commands({ ...input, inputReaders: readers })
          const tests = testsOf(without)
          const left = leftOut(tests, HARNESS_PROJECTS)
          // Only a gate:full that runs the changed harness keeps a reader's project it would leave out.
          const kept =
            shape === 'full'
              ? [...new Set(readers.map(projectOf))].filter((p) => left.includes(p))
              : []
          expect(othersOf(withReaders)).toEqual(othersOf(without))
          expect(leftOut(testsOf(withReaders), HARNESS_PROJECTS)).toEqual(
            left.filter((p) => !kept.includes(p)),
          )
          expect(testsOf(withReaders) === tests).toBe(kept.length === 0)
          // The plain gate's Vitest run starts with the base; gate:full's commands carry none at all.
          const runs = !input.full && tests !== 'true'
          const first = envWords(tests)[0] ?? []
          expect(first.findIndex(([name]) => name === 'GATE_BASE')).toBe(runs ? 0 : -1)
          expect(first.find(([name]) => name === 'GATE_BASE')?.[1] ?? null).toBe(runs ? BASE : null)
          expect(
            input.full ? [...without, ...withReaders].filter((c) => c.includes('GATE_BASE=')) : [],
          ).toEqual([])
        },
      ),
      { numRuns: 120 },
    )
  })
})

describe('AC-5: a gate:full that runs only the changed harness keeps the projects of the tests reading the change', () => {
  const REPO = fileURLToPath(new URL('../../', import.meta.url))

  /** The projects gate:full's tests step collects, through vitest list, for a change in this checkout. */
  async function fullProjects(changed: string[]): Promise<{ readers: string[]; listed: string[] }> {
    const readers = harnessInputTests(REPO, changed)
    const step = plan({
      full: true,
      base: BASE,
      changed,
      mutated: [],
      harness: 'changed',
      inputReaders: readers,
    }).steps.find((s) => s.name === 'tests')
    if (step === undefined) throw new Error('no tests step')
    const { env, projects, excludes } = vitestFilters(step.command)
    const listed = await listedProjects(
      [...projects.flatMap((p) => ['--project', p]), ...excludes.flatMap((e) => ['--exclude', e])],
      env,
    )
    return { readers, listed }
  }

  it('AC-5: through vitest list, a change to registry/adapters.json keeps tooling, and a kernel change no tooling test reads leaves it out', async () => {
    const registry = await fullProjects(['registry/adapters.json'])
    const kernel = await fullProjects([KERNEL])
    expect(registry.readers.filter((f) => f.startsWith('tests/tooling/'))).toContain(
      'tests/tooling/adapter-list.test.ts',
    )
    expect(registry.listed).toContain('tooling')
    expect(kernel.readers.filter((f) => f.startsWith('tests/tooling/'))).toEqual([])
    expect(kernel.listed).not.toContain('tooling')
    expect(kernel.listed).toEqual(registry.listed.filter((p) => p !== 'tooling'))
  }, 120_000)
})
