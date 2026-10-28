// Reads: .changeset/**, package.json, pnpm-workspace.yaml, packages/*/package.json, apps/*/package.json
// Reads: templates/*/package.json
import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

describe('AC-8: changeset version on the committed changesets versions only published packages', () => {
  const members = workspaceMembers()
  const byName = new Map(members.map((m) => [m.manifest.name, m]))
  let scratch: string
  let named: Set<string>
  let before: Map<string, string | undefined>
  let after: Map<string, string | undefined>
  let run: { status: number | null; output: string }

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'changeset-version-'))
    for (const file of ['package.json', 'pnpm-workspace.yaml']) {
      cpSync(join(REPO_ROOT, file), join(scratch, file))
    }
    for (const { dir } of members) {
      if (dir === '') continue
      mkdirSync(join(scratch, dir), { recursive: true })
      cpSync(join(REPO_ROOT, dir, 'package.json'), join(scratch, dir, 'package.json'))
    }
    cpSync(join(REPO_ROOT, '.changeset'), join(scratch, '.changeset'), { recursive: true })
    named = namedPackages(join(scratch, '.changeset'))
    git(scratch, 'init', '-q')
    git(scratch, 'add', '-A')
    git(scratch, 'commit', '-q', '-m', 'scratch')
    // Linked after the commit so it is never staged; the config's changelog resolves through it.
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(scratch, 'node_modules'), 'dir')

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
