// Reads: .changeset/**, package.json, pnpm-workspace.yaml, packages/*/package.json, apps/*/package.json
// Reads: templates/*/package.json, packages/adapters/*/*/package.json
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import semver from 'semver'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADAPTER_NAMES, MOVED_ADAPTERS } from '../architecture/adapter-table'
import {
  REPO_ROOT,
  isPublished,
  workspaceMembers,
  type WorkspaceMember,
} from '../architecture/workspace-manifests'

// AC-8: `pnpm changeset version` succeeds on the repository's changesets in a scratch repository and versions only
// published packages. The scratch repository holds the workspace manifests, pnpm-workspace.yaml and .changeset/
// (sources are irrelevant to versioning); node_modules is linked, not installed. It holds on every branch: with no
// pending changesets nothing is named and nothing may change.

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd, encoding: 'utf8' },
  )
}

/** Package names a changeset's frontmatter names (`"name": bump`). */
function namedPackages(changesetDir: string): Set<string> {
  const names = new Set<string>()
  for (const file of readdirSync(changesetDir)) {
    if (!file.endsWith('.md') || file === 'README.md') continue
    const text = readFileSync(join(changesetDir, file), 'utf8')
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
    for (const line of front.split(/\r?\n/)) {
      const m = /^\s*["']?([^"':\s]+)["']?\s*:\s*(major|minor|patch|none)\s*$/.exec(line)
      if (m?.[1]) names.add(m[1])
    }
  }
  return names
}

function versions(root: string, members: WorkspaceMember[]): Map<string, string | undefined> {
  return new Map(
    members.map((m) => [
      m.dir,
      (JSON.parse(readFileSync(join(root, m.dir, 'package.json'), 'utf8')) as { version?: string })
        .version,
    ]),
  )
}

/**
 * A scratch repository of the workspace manifests, pnpm-workspace.yaml and .changeset/, after `edit` has changed it,
 * committed, with the repository's node_modules linked in.
 */
function scratchRepository(members: WorkspaceMember[], edit?: (scratch: string) => void): string {
  const scratch = mkdtempSync(join(tmpdir(), 'changeset-version-'))
  for (const file of ['package.json', 'pnpm-workspace.yaml']) {
    cpSync(join(REPO_ROOT, file), join(scratch, file))
  }
  for (const { dir } of members) {
    if (dir === '') continue
    mkdirSync(join(scratch, dir), { recursive: true })
    cpSync(join(REPO_ROOT, dir, 'package.json'), join(scratch, dir, 'package.json'))
  }
  cpSync(join(REPO_ROOT, '.changeset'), join(scratch, '.changeset'), { recursive: true })
  edit?.(scratch)
  git(scratch, 'init', '-q')
  git(scratch, 'add', '-A')
  git(scratch, 'commit', '-q', '-m', 'scratch')
  // Linked after the commit so it is never staged; the config's changelog resolves through it.
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(scratch, 'node_modules'), 'dir')
  return scratch
}

describe('AC-8: changeset version on the committed changesets versions only published packages', () => {
  const members = workspaceMembers()
  const byName = new Map(members.map((m) => [m.manifest.name, m]))
  let scratch: string
  let named: Set<string>
  let before: Map<string, string | undefined>
  let after: Map<string, string | undefined>
  let run: { status: number | null; output: string }

  beforeAll(() => {
    scratch = scratchRepository(members)
    named = namedPackages(join(scratch, '.changeset'))

    before = versions(scratch, members)
    const res = spawnSync('pnpm', ['changeset', 'version'], {
      cwd: scratch,
      encoding: 'utf8',
      env: { ...process.env, CI: '1' },
      timeout: 120_000,
    })
    run = { status: res.status, output: `${res.stdout}\n${res.stderr}` }
    after = versions(scratch, members)
  }, 180_000)

  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  })

  it('AC-8: every changeset names only published workspace packages', () => {
    // A private or unknown name aborts the release or versions a package that never ships.
    const unpublishable = [...named].filter((n) => {
      const m = byName.get(n)
      return m === undefined || !isPublished(m.manifest)
    })
    expect(unpublishable).toEqual([])
  })

  it('AC-8: changeset version succeeds and changes only published packages, including every one named', () => {
    expect(run.status, run.output).toBe(0)
    const changed = members.filter((m) => before.get(m.dir) !== after.get(m.dir))
    const privateChanged = changed.filter((m) => !isPublished(m.manifest)).map((m) => m.dir)
    expect(privateChanged, `private packages versioned:\n${run.output}`).toEqual([])
    const namedUnchanged = [...named].filter((n) => {
      const m = byName.get(n)
      return m !== undefined && before.get(m.dir) === after.get(m.dir)
    })
    expect(namedUnchanged, `named packages not versioned:\n${run.output}`).toEqual([])
    const namedPublished = [...named].filter((n) => {
      const m = byName.get(n)
      return m !== undefined && isPublished(m.manifest)
    })
    expect(changed.length).toBeGreaterThanOrEqual(namedPublished.length)
  })
})

// The adapters version on their own. Each case empties the scratch's pending changesets and writes its own, so it
// holds whatever is pending in the repository. The core group and @nymbalhq/contract-tests still move together.

type Bump = 'minor' | 'patch'

const GROUP: readonly string[] = [
  '@nymbalhq/stack',
  'nymbal',
  '@nymbalhq/config',
  '@nymbalhq/platform',
  '@nymbalhq/sdk',
  '@nymbalhq/types',
  '@nymbalhq/web-components',
  '@nymbalhq/http',
  '@nymbalhq/react',
  '@nymbalhq/admin',
  '@nymbalhq/contract-tests',
]
/** The nine adapters published under a new name, and the three that kept theirs. */
const RENAMED: readonly string[] = MOVED_ADAPTERS.filter((a) => a.retired !== undefined).map(
  (a) => a.name,
)
const KEPT_NAME: readonly string[] = MOVED_ADAPTERS.filter((a) => a.retired === undefined).map(
  (a) => a.name,
)

/** `version` one `bump` up: 1.4.0 is 1.5.0 at minor and 1.4.1 at patch. */
function bumped(version: string | undefined, bump: Bump): string {
  const [major = NaN, minor = NaN, patch = NaN] = (version ?? '').split('.').map(Number)
  return bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`
}

interface Versioned {
  run: { status: number | null; output: string }
  before: Map<string, string | undefined>
  after: Map<string, string | undefined>
  /** The packages `changeset version` wrote a CHANGELOG.md for (the scratch copies none). */
  changelogs: Set<string>
  /** Each adapter's @nymbalhq/types peer range after the run. */
  typesFloors: Map<string, string | undefined>
}

/** The scratch's pending changesets emptied, and one changeset written per entry of `changesets`. */
const onlyChangesets =
  (changesets: Record<string, Record<string, Bump>>) =>
  (scratch: string): void => {
    const dir = join(scratch, '.changeset')
    for (const file of readdirSync(dir)) if (file.endsWith('.md')) rmSync(join(dir, file))
    for (const [file, bumps] of Object.entries(changesets)) {
      const front = Object.entries(bumps).map(([name, bump]) => `"${name}": ${bump}`)
      writeFileSync(
        join(dir, `${file}.md`),
        ['---', ...front, '---', '', 'A fixture.', ''].join('\n'),
      )
    }
  }

function changesetVersion(cwd: string): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['changeset', 'version'], {
      cwd,
      env: { ...process.env, CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('close', (status) => resolve({ status, output }))
  })
}

describe('AC-1, AC-2, AC-3: the adapters version on their own', () => {
  const members = workspaceMembers().filter((m) => m.dir !== '' && isPublished(m.manifest))
  const dirOf = new Map(members.map((m) => [m.manifest.name ?? '', m.dir]))
  const scratches: string[] = []
  const byName = (root: string): Map<string, string | undefined> =>
    new Map(
      members.map((m) => [
        m.manifest.name ?? '',
        (
          JSON.parse(readFileSync(join(root, m.dir, 'package.json'), 'utf8')) as {
            version?: string
          }
        ).version,
      ]),
    )

  async function versioned(edit: (scratch: string) => void): Promise<Versioned> {
    const scratch = scratchRepository(workspaceMembers(), edit)
    scratches.push(scratch)
    const before = byName(scratch)
    const run = await changesetVersion(scratch)
    const changelogs = new Set(
      [...dirOf]
        .filter(([, dir]) => existsSync(join(scratch, dir, 'CHANGELOG.md')))
        .map(([n]) => n),
    )
    const typesFloors = new Map(
      MOVED_ADAPTERS.map((a) => [
        a.name,
        (
          JSON.parse(readFileSync(join(scratch, a.dir, 'package.json'), 'utf8')) as {
            peerDependencies?: Record<string, string>
          }
        ).peerDependencies?.['@nymbalhq/types'],
      ]),
    )
    return { run, before, after: byName(scratch), changelogs, typesFloors }
  }

  /** The state before the nine's first publish: every adapter at the group's version, as the manifests are today. */
  const adaptersAtGroupVersion = (scratch: string): void => {
    const platform = JSON.parse(
      readFileSync(join(scratch, 'packages/platform/package.json'), 'utf8'),
    ) as { version: string }
    for (const { dir } of MOVED_ADAPTERS) {
      const path = join(scratch, dir, 'package.json')
      const m = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      writeFileSync(path, `${JSON.stringify({ ...m, version: platform.version }, null, 2)}\n`)
    }
  }

  let platformMinor: Versioned
  let typesMinor: Versioned
  let smtpPatch: Versioned
  let firstPublish: Versioned

  beforeAll(async () => {
    ;[platformMinor, typesMinor, smtpPatch, firstPublish] = await Promise.all([
      versioned(onlyChangesets({ platform: { '@nymbalhq/platform': 'minor' } })),
      versioned(onlyChangesets({ types: { '@nymbalhq/types': 'minor' } })),
      versioned(onlyChangesets({ smtp: { '@nymbalhq/email-smtp': 'patch' } })),
      versioned((scratch) => {
        adaptersAtGroupVersion(scratch)
        onlyChangesets({
          renamed: Object.fromEntries(RENAMED.map((n) => [n, 'minor' as const])),
          group: { '@nymbalhq/platform': 'minor' },
          'kept-name': Object.fromEntries(KEPT_NAME.map((n) => [n, 'patch' as const])),
        })(scratch)
      }),
    ])
  }, 180_000)

  afterAll(() => {
    for (const scratch of scratches.splice(0)) rmSync(scratch, { recursive: true, force: true })
  })

  /** Each of `names` whose version the run changed, as `name before -> after`. */
  const moved = (v: Versioned, names: Iterable<string>): string[] =>
    [...names]
      .filter((n) => v.after.get(n) !== v.before.get(n))
      .map((n) => `${n} ${v.before.get(n)} -> ${v.after.get(n)}`)
  /** Each core member and contract-tests not at `version` after the run. */
  const offGroup = (v: Versioned, version: string): string[] =>
    GROUP.filter((n) => v.after.get(n) !== version).map((n) => `${n} ${v.after.get(n)}`)

  it("AC-1: a minor on @nymbalhq/platform alone changes no adapter's version or CHANGELOG, and every core member and contract-tests land on the platform's new version", () => {
    const v = platformMinor
    expect(v.run.status, v.run.output).toBe(0)
    const group = bumped(v.before.get('@nymbalhq/platform'), 'minor')

    expect(moved(v, ADAPTER_NAMES)).toEqual([])
    expect(ADAPTER_NAMES.filter((n) => v.changelogs.has(n))).toEqual([])
    expect(v.after.get('@nymbalhq/platform')).toBe(group)
    expect(offGroup(v, group)).toEqual([])
  })

  it("AC-4: after AC-1's minor on @nymbalhq/platform, the versioned @nymbalhq/types satisfies every adapter's @nymbalhq/types floor", () => {
    const v = platformMinor
    expect(v.run.status, v.run.output).toBe(0)
    const types = v.after.get('@nymbalhq/types') ?? ''
    expect(types).toBe(bumped(v.before.get('@nymbalhq/types'), 'minor'))
    expect(v.typesFloors.size).toBe(MOVED_ADAPTERS.length)

    expect(
      [...v.typesFloors]
        .filter(([, floor]) => floor === undefined || !semver.satisfies(types, floor))
        .map(([name, floor]) => `${name}: ${types} does not satisfy ${floor}`),
    ).toEqual([])
  })

  it("AC-1: a minor on @nymbalhq/types alone changes no adapter's version, and every core member and contract-tests land on the types' new version", () => {
    const v = typesMinor
    expect(v.run.status, v.run.output).toBe(0)
    const group = bumped(v.before.get('@nymbalhq/types'), 'minor')

    expect(moved(v, ADAPTER_NAMES)).toEqual([])
    expect(v.after.get('@nymbalhq/types')).toBe(group)
    expect(offGroup(v, group)).toEqual([])
  })

  it('AC-2: a patch on @nymbalhq/email-smtp alone versions smtp and nothing else: mailgun, resend and ses keep their versions', () => {
    const v = smtpPatch
    expect(v.run.status, v.run.output).toBe(0)
    const smtp = '@nymbalhq/email-smtp'

    expect(moved(v, v.before.keys())).toEqual([
      `${smtp} ${v.before.get(smtp)} -> ${bumped(v.before.get(smtp), 'patch')}`,
    ])
  })

  it('AC-3: with a minor on each of the nine renamed adapters and a minor on the group, the nine land at the version the group gets, and the three that kept their names take their own patch', () => {
    const v = firstPublish
    expect(v.run.status, v.run.output).toBe(0)
    const group = bumped(v.before.get('@nymbalhq/platform'), 'minor')

    expect(v.after.get('@nymbalhq/platform')).toBe(group)
    expect(
      RENAMED.filter((n) => v.after.get(n) !== group).map((n) => `${n} ${v.after.get(n)}`),
    ).toEqual([])
    expect(
      KEPT_NAME.filter((n) => v.after.get(n) !== bumped(v.before.get(n), 'patch')).map(
        (n) => `${n} ${v.before.get(n)} -> ${v.after.get(n)}`,
      ),
    ).toEqual([])
  })
})
