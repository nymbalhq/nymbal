// Reads: packages/adapters/**, registry/README.md, README.md, package.json, packages/cli/src/index.ts
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIRST_PARTY_ADAPTERS, ROOT } from './adapter-table'
import { privateWords } from './private-words'
import { workspaceMembers } from './workspace-manifests'

// AC-6: the contributor's guide (packages/adapters/README.md) and the new-adapter skill beside it name only what
// exists: every repository path, every `pnpm` command (a root script, a pnpm command or a bin) and every `nymbal`
// command (one the CLI's command table has). The registry README and the root README link the guide, the guide and the
// root README say how the skill loads, and none of them carries the private process's words.

const GUIDE = 'packages/adapters/README.md'
const SKILL = 'packages/adapters/.claude/skills/new-adapter/SKILL.md'
const DOCS = [GUIDE, SKILL] as const

const read = (path: string): string =>
  existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), 'utf8') : ''

/** A markdown file's YAML frontmatter, one-line and folded (`>`, `|`) values. */
function frontmatter(text: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
  const out: Record<string, string> = {}
  let folding: string | undefined
  for (const line of block.split('\n')) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line)
    if (m !== null) {
      const value = m[2]!.trim()
      folding =
        value === '>' || value === '|' || value === '>-' || value === '|-' ? m[1] : undefined
      out[m[1]!] = folding === undefined ? value.replace(/^(['"])(.*)\1$/, '$2') : ''
    } else if (folding !== undefined && /^\s+\S/.test(line)) {
      out[folding] = `${out[folding]} ${line.trim()}`.trim()
    }
  }
  return out
}

/** The code a markdown text holds: each inline code span and each line of each fenced block. */
function codeOf(text: string): string[] {
  const fenced = [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].flatMap((m) =>
    m[1]!.split('\n'),
  )
  const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, '')
  const spans = [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!)
  return [...fenced, ...spans].map((l) => l.trim()).filter(Boolean)
}

/** Markdown link targets, without an anchor; web and mail links aside. */
const linkTargets = (text: string): string[] =>
  [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)]
    .map((m) => m[1]!.replace(/#.*$/, ''))
    .filter((t) => t !== '' && !/^[a-z]+:/i.test(t))

const TOP_LEVEL = new Set(readdirSync(ROOT))

/** A placeholder, glob or shell variable stands for a path that need not exist. */
const isPattern = (token: string): boolean => /[<>*{}$…]|\.\.\./.test(token)

/** The repository paths a code line names: tokens under a top-level entry of the repository, or a package's src/. */
function pathsIn(line: string): string[] {
  return line
    .split(/\s+/)
    .map((t) => t.replace(/^[`'"(]+|[`'",.:;)]+$/g, ''))
    .filter((t) => t.includes('/') && !isPattern(t) && !/^[a-z]+:\/\//i.test(t))
    .filter((t) => TOP_LEVEL.has(t.split('/')[0]!) || t.startsWith('src/'))
}

/** A path exists from the root, from the doc's directory, or (package-relative) in some first-party adapter. */
function exists(path: string, doc: string): boolean {
  const clean = path.replace(/\/$/, '')
  return (
    existsSync(join(ROOT, clean)) ||
    existsSync(join(ROOT, dirname(doc), clean)) ||
    FIRST_PARTY_ADAPTERS.some((a) => existsSync(join(ROOT, a.dir, clean)))
  )
}

const rootManifest = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
const ROOT_SCRIPTS = new Set(Object.keys(rootManifest.scripts ?? {}))
const ROOT_BINS = new Set(
  existsSync(join(ROOT, 'node_modules', '.bin'))
    ? readdirSync(join(ROOT, 'node_modules', '.bin'))
    : [],
)
const PNPM_COMMANDS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'update',
  'exec',
  'dlx',
  'run',
  'test',
  'list',
  'why',
  'publish',
  'pack',
])

/** The CLI's command table: the keys of `subCommands` in packages/cli/src/index.ts. */
function cliCommands(): Set<string> {
  const source = read('packages/cli/src/index.ts')
  const table = /subCommands:\s*\{([\s\S]*?)\n\s*\}/.exec(source)?.[1] ?? ''
  return new Set([...table.matchAll(/^\s*(?:'([^']+)'|([\w-]+))\s*:/gm)].map((m) => m[1] ?? m[2]!))
}

/** What is wrong with a `pnpm …` or `nymbal …` command line, if anything. */
function commandProblem(line: string, cli: ReadonlySet<string>): string | undefined {
  const tokens = line.replace(/^\$\s+/, '').split(/\s+/)
  const [tool, ...rest] = tokens
  if (tool !== 'pnpm' && tool !== 'nymbal') return undefined
  let filter: string | undefined
  const args: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!
    if (t === '--filter' || t === '-F' || t === '-C' || t === '--dir') filter = rest[++i]
    else if (t.startsWith('--filter=')) filter = t.slice('--filter='.length)
    else if (args.length === 0 && t.startsWith('-')) continue
    else args.push(t)
  }
  const [command, next] = args
  if (command === undefined || isPattern(command)) return undefined
  if (tool === 'nymbal') return cli.has(command) ? undefined : `nymbal has no command ${command}`
  const filtered =
    filter === undefined || isPattern(filter)
      ? undefined
      : workspaceMembers(ROOT).find(
          (m) => m.manifest.name === filter || m.dir === filter.replace(/^\.\//, ''),
        )
  if (filter !== undefined && !isPattern(filter) && filtered === undefined)
    return `no workspace package ${filter}`
  const scripts = new Set(
    Object.keys((filtered?.manifest.scripts as Record<string, string> | undefined) ?? {}),
  )
  const isScript = (s: string): boolean => (filtered === undefined ? ROOT_SCRIPTS : scripts).has(s)
  if (command === 'run') {
    return next === undefined || isPattern(next) || isScript(next) ? undefined : `no script ${next}`
  }
  if (command === 'exec') {
    return next === undefined || isPattern(next) || ROOT_BINS.has(next)
      ? undefined
      : `no bin ${next}`
  }
  return isScript(command) || PNPM_COMMANDS.has(command) || ROOT_BINS.has(command)
    ? undefined
    : `pnpm has no script, command or bin ${command}`
}

describe('AC-6: the guide and the skill name only what exists', () => {
  it("AC-6: the guide and the skill exist, and the skill's frontmatter names it after its directory and describes it", () => {
    const front = frontmatter(read(SKILL))

    expect(DOCS.filter((d) => !existsSync(join(ROOT, d)))).toEqual([])
    expect(front['name']).toBe(basename(dirname(SKILL)))
    expect(front['description'] ?? '').toMatch(/adapter/i)
  })

  it('AC-6: every repository path the guide and the skill name exists', () => {
    const named = DOCS.flatMap((doc) => {
      const text = read(doc)
      return [
        ...codeOf(text).flatMap(pathsIn),
        ...linkTargets(text).filter((t) => !isPattern(t)),
      ].map((path) => ({ doc, path }))
    })

    expect(DOCS.filter((d) => read(d) === '')).toEqual([])
    expect(named.filter((n) => !exists(n.path, n.doc)).map((n) => `${n.doc}: ${n.path}`)).toEqual(
      [],
    )
  })

  it('AC-6: every pnpm and nymbal command the guide and the skill give is a root script, a pnpm command, a bin or a CLI command', () => {
    const cli = cliCommands()
    const commands = DOCS.flatMap((doc) =>
      codeOf(read(doc))
        .filter((l) => /^(\$\s+)?(pnpm|nymbal)\s/.test(l))
        .map((line) => ({ doc, line })),
    )
    const problems = commands.flatMap(({ doc, line }) => {
      const problem = commandProblem(line, cli)
      return problem === undefined ? [] : [`${doc}: ${line}: ${problem}`]
    })

    expect(
      commands
        .filter((c) => /\bnew-adapter\b/.test(c.line))
        .map((c) => c.doc)
        .sort(),
    ).toEqual(expect.arrayContaining([...DOCS].sort()))
    expect(problems).toEqual([])
  })

  it('AC-6: registry/README.md and the root README link the guide', () => {
    const guide = resolve(ROOT, GUIDE)
    const linking = ['registry/README.md', 'README.md'].filter((file) =>
      linkTargets(read(file)).some((t) => resolve(ROOT, dirname(file), t) === guide),
    )

    expect(linking).toEqual(['registry/README.md', 'README.md'])
  })

  it('AC-6: the guide and the root README say how the skill loads: in packages/adapters, by /add-dir, or by reading the guide', () => {
    const loads = [
      /\/add-dir\s+`?packages\/adapters/,
      /\b(?:start|open|launch|run)\b[^.\n]{0,80}\bin\s+`?packages\/adapters\/?`?(?![\w/])/i,
      /\bread\b[^.\n]{0,80}packages\/adapters\/README\.md/i,
    ]
    const silent = [GUIDE, 'README.md'].filter((file) => {
      const text = read(file)
      return !/\bskill\b/i.test(text) || !loads.some((re) => re.test(text))
    })

    expect(silent).toEqual([])
  })

  it('AC-6: the guide and the skill hold no task id, phase number or private process word', () => {
    const found = DOCS.flatMap((doc) => privateWords(read(doc)).map((w) => `${doc}: ${w}`))

    expect(DOCS.filter((d) => read(d) === '')).toEqual([])
    expect(found).toEqual([])
  })
})
