// Reads: **
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from './adapter-table'
import {
  cliTree,
  codeOf,
  isPattern,
  linkTargets,
  nymbalInvocations,
  nymbalProblem,
  packageManagerProblem,
} from './doc-commands'
import { privateWords } from './private-words'
import { isPublished, workspaceMembers, type Manifest } from './workspace-manifests'

// AC-1 to AC-4 and AC-11: the text a user of Nymbal reads (the READMEs, the repository's policies, the docs site, the
// issue forms) names only what this release has. Every `nymbal` command and flag is in the CLI's tree, every script
// is in the package.json beside the text, every link and repository path resolves, and no private word appears. The
// root README lists every published package and the Node floor the packages require; every published package has a
// README and the repository its licence; the quickstart page is the steps scripts/quickstart.sh runs. Links and paths
// resolve against the files git tracks or would add, so the verdict rests on the whole checkout, hence `**`.

const DOCS_CONTENT = 'apps/docs/src/content/docs/'
const QUICKSTART_PAGE = `${DOCS_CONTENT}quickstart.md`
const QUICKSTART_SCRIPT = 'scripts/quickstart.sh'
const REPO_URL =
  /https:\/\/github\.com\/nymbalhq\/nymbal\/(?:blob|tree)\/(?:main|dev)\/([^\s)#"'`]+)(#[^\s)"'`]+)?/g

const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  },
)
  .split('\0')
  .filter((f) => f !== '' && !f.includes('node_modules/'))
const fileSet = new Set(files)
const dirSet = new Set(
  files.flatMap((f) =>
    f
      .split('/')
      .slice(0, -1)
      .map((_, i, parts) => parts.slice(0, i + 1).join('/')),
  ),
)
const tracked = (path: string): boolean => fileSet.has(path) || dirSet.has(path.replace(/\/$/, ''))
const TOP_LEVEL = new Set(files.map((f) => f.split('/')[0]!))

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')

const members = workspaceMembers(ROOT)
const published = members.filter((m) => m.dir !== '' && isPublished(m.manifest))

/** The public text AC-1 reads. */
const PUBLIC_DOCS = [
  'README.md',
  'OVERRIDES.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  ...files.filter((f) => /^templates\/[^/]+\/README\.md$/.test(f)),
  ...files.filter((f) => /^packages\/create-app\/scaffold\/templates\/[^/]+\/README\.md$/.test(f)),
  ...published.map((m) => `${m.dir}/README.md`).filter((f) => fileSet.has(f)),
  ...files.filter((f) => f.startsWith(DOCS_CONTENT) && /\.mdx?$/.test(f)),
  ...files.filter((f) => f.startsWith('.github/ISSUE_TEMPLATE/')),
].sort()

const scriptsOf = (dir: string): Set<string> => {
  const manifest = JSON.parse(read(posix.join(dir, 'package.json'))) as Manifest
  return new Set(Object.keys((manifest['scripts'] as Record<string, string> | undefined) ?? {}))
}

/**
 * The scripts a text's `pnpm <script>` may name: the package.json beside it. A template's README ships beside the
 * scaffold's package.json, and a docs page speaks to a store, so both read the scaffolds' (each template's).
 */
function scriptsFor(doc: string): Set<string> {
  const template = /^templates\/([^/]+)\/README\.md$/.exec(doc)?.[1]
  if (template !== undefined) return scriptsOf(`packages/create-app/scaffold/templates/${template}`)
  if (doc.startsWith(DOCS_CONTENT)) {
    const scaffolds = files
      .filter((f) => /^packages\/create-app\/scaffold\/templates\/[^/]+\/package\.json$/.test(f))
      .map((f) => scriptsOf(posix.dirname(f)))
    return new Set([...scaffolds[0]!].filter((s) => scaffolds.every((set) => set.has(s))))
  }
  let dir = posix.dirname(doc)
  while (dir !== '.' && !fileSet.has(`${dir}/package.json`)) dir = posix.dirname(dir)
  return scriptsOf(dir)
}

/** The id a heading gets on GitHub and in the docs site (github-slugger): lower case, punctuation dropped. */
function slug(heading: string): string {
  return heading
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/ /g, '-')
}

/** Every anchor a Markdown file's headings give, a repeated heading numbered as GitHub numbers it. */
function anchorsOf(path: string): Set<string> {
  const seen = new Map<string, number>()
  const text = read(path).replace(/^\s*```[^\n]*\n[\s\S]*?^\s*```/gm, '')
  const anchors = new Set<string>()
  for (const m of text.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(m[1]!)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    anchors.add(n === 0 ? base : `${base}-${n}`)
  }
  return anchors
}

/** A docs page's URL path in the built site: `quickstart.md` is /quickstart/, `index.md` is /. */
function pageUrl(page: string): string {
  const path = page
    .slice(DOCS_CONTENT.length)
    .replace(/\.mdx?$/, '')
    .replace(/(^|\/)index$/, '')
  return path === '' ? '/' : `/${path}/`
}
const PAGES = new Map(
  files.filter((f) => f.startsWith(DOCS_CONTENT) && /\.mdx?$/.test(f)).map((f) => [pageUrl(f), f]),
)

/** What is wrong with a repository path and its anchor, if anything. */
function pathProblem(path: string, anchor: string | undefined): string | undefined {
  const clean = posix.normalize(decodeURIComponent(path))
  if (!tracked(clean)) return `${clean} is not in the repository`
  if (anchor !== undefined && /\.mdx?$/.test(clean) && !anchorsOf(clean).has(anchor.slice(1))) {
    return `${clean} has no heading ${anchor}`
  }
  return undefined
}

/** What is wrong with one link target of `doc`, if anything. */
function linkProblem(doc: string, target: string): string | undefined {
  const repo = new RegExp(REPO_URL.source).exec(target)
  if (repo !== null) return pathProblem(repo[1]!, repo[2])
  if (/^[a-z]+:/i.test(target) || isPattern(target)) return undefined
  const [path, hash] = target.split('#') as [string, string | undefined]
  const anchor = hash === undefined ? undefined : `#${hash}`
  if (path === '') {
    return anchor === undefined || anchorsOf(doc).has(anchor.slice(1))
      ? undefined
      : `no heading ${anchor}`
  }
  // A docs page links the site's pages by URL; a link to a file is a repository path either way.
  if (doc.startsWith(DOCS_CONTENT) && !/\.[a-z]+$/i.test(path)) {
    const url = new URL(path, `https://docs.invalid${pageUrl(doc)}`).pathname
    const page = PAGES.get(url.endsWith('/') ? url : `${url}/`)
    if (page === undefined) return `no docs page at ${url}`
    return anchor === undefined || anchorsOf(page).has(anchor.slice(1))
      ? undefined
      : `${url} has no heading ${anchor}`
  }
  return pathProblem(posix.join(posix.dirname(doc), path), anchor)
}

/** The repository paths a code line names: tokens under a top-level entry of the repository. */
function pathsIn(line: string): string[] {
  return line
    .split(/\s+/)
    .map((t) => t.replace(/^[`'"(]+|[`'",.:;)]+$/g, ''))
    .filter((t) => t.includes('/') && !isPattern(t) && !/^[a-z]+:\/\//i.test(t))
    .filter((t) => TOP_LEVEL.has(t.split('/')[0]!) && t.split('/')[0] !== '')
}

describe('AC-1: public text names only commands, scripts, links and paths that exist', () => {
  it('AC-1: the public docs are there to read: the root files, both template READMEs, a docs page per guide and the issue forms', () => {
    const expected = [
      'README.md',
      'CONTRIBUTING.md',
      'SECURITY.md',
      'templates/astro/README.md',
      'templates/nextjs/README.md',
      QUICKSTART_PAGE,
      `${DOCS_CONTENT}reference/cli.md`,
      '.github/ISSUE_TEMPLATE/bug_report.yml',
    ]

    expect(expected.filter((f) => !fileSet.has(f))).toEqual([])
    expect(PUBLIC_DOCS.length).toBeGreaterThan(published.length)
  })

  it('AC-1: every nymbal command line names a command or nested subcommand of the CLI and only flags it declares', async () => {
    const cli = await cliTree()
    const invocations = PUBLIC_DOCS.flatMap((doc) =>
      codeOf(read(doc)).flatMap((line) =>
        nymbalInvocations(line).map((args) => ({ doc, line, args })),
      ),
    )
    const problems = invocations.flatMap(({ doc, line, args }) => {
      const problem = nymbalProblem(args, cli)
      return problem === undefined ? [] : [`${doc}: ${line}: ${problem}`]
    })

    expect(problems).toEqual([])
    expect(invocations.length).toBeGreaterThan(PUBLIC_DOCS.length)
  })

  it('AC-1: every pnpm and npm run script is in the package.json beside the text (a pnpm command or a root bin otherwise)', () => {
    const lines = PUBLIC_DOCS.flatMap((doc) =>
      codeOf(read(doc))
        .filter((line) => /^(\$\s+)?(pnpm|npm run)\s/.test(line))
        .map((line) => ({ doc, line })),
    )
    const problems = lines.flatMap(({ doc, line }) => {
      const problem = packageManagerProblem(line, scriptsFor(doc))
      return problem === undefined ? [] : [`${doc}: ${line}: ${problem}`]
    })

    expect(problems).toEqual([])
    expect(lines.length).toBeGreaterThan(0)
  })

  it('AC-1: every relative link, repository URL, docs-site link and #anchor resolves to a tracked file, a docs page and a heading of it', () => {
    const links = PUBLIC_DOCS.flatMap((doc) => {
      const text = read(doc)
      const urls = [...text.matchAll(REPO_URL)].map((m) => m[0])
      return [...new Set([...linkTargets(text), ...urls])].map((target) => ({ doc, target }))
    })
    const problems = links.flatMap(({ doc, target }) => {
      const problem = linkProblem(doc, target)
      return problem === undefined ? [] : [`${doc}: ${target}: ${problem}`]
    })

    expect(problems).toEqual([])
    expect(links.length).toBeGreaterThan(PUBLIC_DOCS.length)
  })

  it('AC-1: every repository path a code line names is in the repository', () => {
    const named = PUBLIC_DOCS.flatMap((doc) =>
      codeOf(read(doc)).flatMap((line) => pathsIn(line).map((path) => ({ doc, path }))),
    )

    expect(
      named.filter((n) => !tracked(posix.normalize(n.path))).map((n) => `${n.doc}: ${n.path}`),
    ).toEqual([])
    expect(named.length).toBeGreaterThan(0)
  })
})

describe('AC-2: public text carries no private word', () => {
  it('AC-2: none of the public docs holds a task id, a phase number or a private process word', () => {
    const found = PUBLIC_DOCS.flatMap((doc) => privateWords(read(doc)).map((w) => `${doc}: ${w}`))

    expect(found).toEqual([])
    expect(PUBLIC_DOCS.filter((doc) => read(doc).trim() === '')).toEqual([])
  })
})

describe("AC-3: the root README's package list and Node floor match the workspace", () => {
  const readme = read('README.md')
  const section = /^## Packages\n([\s\S]*?)(?=^## )/m.exec(readme)?.[1] ?? ''

  it('AC-3: the package list names every published package directory (the adapters as packages/adapters/) and only directories that exist', () => {
    const named = [...section.matchAll(/`((?:packages|apps|templates)\/[\w./-]*?)\/?`/g)].map(
      (m) => m[1]!,
    )
    const expected = [
      ...new Set(
        published.map((m) =>
          m.dir.startsWith('packages/adapters/') ? 'packages/adapters' : m.dir,
        ),
      ),
    ]

    expect(expected.filter((dir) => !named.includes(dir))).toEqual([])
    expect(named.filter((dir) => !tracked(dir))).toEqual([])
    expect(named.length).toBeGreaterThanOrEqual(expected.length)
  })

  it('AC-3: the Node.js floor the README states is the engines floor of nymbal and create-nymbal-app', () => {
    const stated = [...readme.matchAll(/Node\.js (\d+)/g)].map((m) => Number(m[1]))
    const floors = ['nymbal', 'create-nymbal-app'].map((name) => {
      const engines = members.find((m) => m.manifest.name === name)?.manifest['engines'] as
        | { node?: string }
        | undefined
      return Number(/>=\s*(\d+)/.exec(engines?.node ?? '')?.[1])
    })

    expect(stated.length).toBeGreaterThan(0)
    expect([...new Set(stated)]).toEqual([...new Set(floors)])
  })
})

const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`

const words = (text: string): string => text.replace(/\s+/g, ' ').trim()

describe('AC-4: every published package has a README, and the repository the licence its packages name', () => {
  it('AC-4: each published package has a README.md whose first heading is its package name', () => {
    const headings = published.map((m) => {
      const path = `${m.dir}/README.md`
      const heading = fileSet.has(path) ? /^#\s+(.+)$/m.exec(read(path))?.[1]?.trim() : undefined
      return { dir: m.dir, heading }
    })

    expect(
      headings.filter((h) => h.heading !== published.find((m) => m.dir === h.dir)!.manifest.name),
    ).toEqual([])
    expect(headings.length).toBe(published.length)
  })

  it('AC-4: LICENSE is the MIT licence with a copyright line, and it is the licence every published package.json names', () => {
    const text = fileSet.has('LICENSE') ? read('LICENSE') : ''
    const [title, ...rest] = text.split('\n')
    const copyright = rest.find((line) => /^Copyright \(c\) \d{4} \S/.test(line))
    const terms = rest.slice(rest.indexOf(copyright ?? '') + 1).join('\n')
    const licences = [...new Set(published.map((m) => m.manifest['license']))]

    expect(title).toBe('MIT License')
    expect(copyright).toMatch(/^Copyright \(c\) \d{4} .+/)
    expect(words(terms)).toBe(words(MIT_TERMS))
    expect(licences).toEqual(['MIT'])
  })
})

/** The command lines of a page's `sh` blocks, in order. */
function pageCommands(text: string): string[] {
  return [...text.matchAll(/^```sh\n([\s\S]*?)^```/gm)].flatMap((m) =>
    m[1]!
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#')),
  )
}

/** A page line as a pattern for a script line: a `<placeholder>` matches any value, and the script may add `-- …`. */
function lineMatcher(pageLine: string): RegExp {
  const body = pageLine
    .split(/(<[^>]+>)/)
    .map((part) => (/^<[^>]+>$/.test(part) ? '\\S+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${body}(?: --(?: .*)?)?$`)
}

/** Which page lines the script runs in the page's order: each matched after the line the one before matched. */
function inOrder(page: string[], script: string[]): { matched: string[]; missing: string[] } {
  const matched: string[] = []
  const missing: string[] = []
  let at = 0
  for (const line of page) {
    const re = lineMatcher(line)
    const found = script.findIndex((s, i) => i >= at && re.test(s))
    if (found < 0) missing.push(line)
    else {
      matched.push(line)
      at = found + 1
    }
  }
  return { matched, missing }
}

describe('AC-11: the quickstart page and scripts/quickstart.sh are one path', () => {
  const page = pageCommands(read(QUICKSTART_PAGE))
  const script = read(QUICKSTART_SCRIPT)
    .split('\n')
    .map((line) => line.trim())

  it("AC-11: every command line of the page's sh blocks is a step of the script, in the page's order", () => {
    const { matched, missing } = inOrder(page, script)

    expect(missing).toEqual([])
    expect(matched.length).toBe(page.length)
    expect(page.length).toBeGreaterThan(10)
  })

  it('AC-11: a page whose steps are swapped, or that gains a step the script does not run, no longer matches', () => {
    const swapped = [...page]
    const build = swapped.findIndex((l) => l.includes('build --image'))
    const migrate = swapped.findIndex((l) => l.endsWith(' migrate'))
    ;[swapped[build], swapped[migrate]] = [swapped[migrate]!, swapped[build]!]
    const extra = [...page.slice(0, 3), 'npx nymbal add redis', ...page.slice(3)]

    expect(build).toBeGreaterThanOrEqual(0)
    expect(migrate).toBeGreaterThan(build)
    expect(inOrder(swapped, script).missing.length).toBeGreaterThan(0)
    expect(inOrder(extra, script).missing).toEqual(['npx nymbal add redis'])
  })
})
