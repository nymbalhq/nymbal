// Reads: package.json, scripts/scaffold-clean.sh, apps/admin/package.json, .github/workflows/release.yml
// Reads: .github/workflows/canary.yml
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// AC-16: every publish path builds @nymbalhq/admin before it publishes, and the admin refuses to pack without its
// dist. Release and canary publish after root `pnpm build`, which builds only packages/**, and
// scripts/scaffold-clean.sh does the same; so without its own build npm would get an admin with no dist.
//
// A command "builds the admin" when it filters pnpm to @nymbalhq/admin (or apps/admin) and runs build, or when it is
// a root script (`pnpm build`, `pnpm run <script>`) whose body does. Comment lines are ignored.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const read = (path: string): string => readFileSync(join(REPO, path), 'utf8')

const ADMIN_FILTER = String.raw`(?:@nymbalhq\/admin|\.?\/?apps\/admin|\.\/apps\/\*\*|'\.\/apps\/\*\*'|"\.\/apps\/\*\*")`
const DIRECT_ADMIN_BUILD = new RegExp(
  String.raw`pnpm\s+(?:(?:--filter|-F)(?:=|\s+)['"]?${ADMIN_FILTER}['"]?|(?:-C|--dir)(?:=|\s+)['"]?\.?\/?apps\/admin['"]?)\s+(?:[^\n;&|]*\s)?(?:run\s+)?build\b`,
)
// A publish command; prose such as an `echo` mentioning "the npm publish" is not one.
const PUBLISH = /\bpnpm\s+(?:exec\s+)?changeset\s+publish\b|\bpnpm\s+(?:-r|--recursive)\s+publish\b/

const rootScripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
  .scripts

function stripComments(text: string): string {
  return text
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line))
    .join('\n')
}

/** Offset of the first command in `text` that builds the admin, directly or through a root script; -1 when none. */
function adminBuildAt(text: string): number {
  const offsets: number[] = []
  const direct = DIRECT_ADMIN_BUILD.exec(text)
  if (direct) offsets.push(direct.index)
  for (const m of text.matchAll(/\bpnpm\s+(?:run\s+)?([\w:-]+)\b/g)) {
    const body = rootScripts[m[1]!]
    if (body && DIRECT_ADMIN_BUILD.test(body.replace(/^(?!pnpm)/, 'pnpm '))) offsets.push(m.index)
    else if (
      body &&
      /--filter\s+['"]?\.\/apps\/\*\*|apps\/admin|@nymbalhq\/admin/.test(body) &&
      /\bbuild\b/.test(body)
    )
      offsets.push(m.index)
  }
  return offsets.length ? Math.min(...offsets) : -1
}

/** The text of each job under `jobs:` in a workflow, keyed by job id (two-space indented keys). */
function jobs(workflow: string): Map<string, string> {
  const lines = workflow.split('\n')
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  if (start < 0) throw new Error('workflow has no jobs: block')
  const found = new Map<string, string>()
  let current: string | null = null
  let body: string[] = []
  for (const line of lines.slice(start + 1)) {
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (key || /^\S/.test(line)) {
      if (current) found.set(current, body.join('\n'))
      current = key ? key[1]! : null
      body = []
      if (!key) break
      continue
    }
    body.push(line)
  }
  if (current) found.set(current, body.join('\n'))
  return found
}

function publishJobsBuildAdminFirst(path: string): string[] {
  const all = jobs(stripComments(read(path)))
  const publishing = [...all].filter(([, text]) => PUBLISH.test(text))
  expect(publishing.length, `${path}: no job publishes`).toBeGreaterThan(0)
  return publishing.flatMap(([id, text]) => {
    const publishAt = PUBLISH.exec(text)!.index
    const buildAt = adminBuildAt(text)
    return buildAt >= 0 && buildAt < publishAt
      ? []
      : [`${path} job ${id}: no @nymbalhq/admin build before publish`]
  })
}

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

describe('AC-16: every publish path builds the admin', () => {
  it('AC-16: in release.yml and canary.yml, every job that publishes builds @nymbalhq/admin before the publish step', () => {
    const missing = ['.github/workflows/release.yml', '.github/workflows/canary.yml'].flatMap(
      publishJobsBuildAdminFirst,
    )
    expect(missing).toEqual([])
  })

  it('AC-16: scripts/scaffold-clean.sh builds @nymbalhq/admin before it publishes', () => {
    const script = stripComments(read('scripts/scaffold-clean.sh'))
    const publishAt = script.search(PUBLISH)
    expect(publishAt).toBeGreaterThan(-1)
    const buildAt = adminBuildAt(script)
    expect(buildAt, 'no @nymbalhq/admin build in scaffold-clean.sh').toBeGreaterThan(-1)
    expect(buildAt).toBeLessThan(publishAt)
  })

  it("AC-16: apps/admin's prepack exits non-zero when dist/index.html is missing, and zero when it is there", () => {
    const manifest = JSON.parse(read('apps/admin/package.json')) as {
      scripts?: Record<string, string>
    }
    const prepack = manifest.scripts?.['prepack']
    expect(prepack, 'apps/admin package.json scripts.prepack').toEqual(expect.any(String))

    // A copy of the package without node_modules or dist, so the real checkout's build state cannot decide it.
    const copy = join(mkdtempSync(join(tmpdir(), 'admin-prepack-')), 'admin')
    scratch.push(join(copy, '..'))
    cpSync(join(REPO, 'apps/admin'), copy, {
      recursive: true,
      filter: (src) =>
        !/[/\\](?:node_modules|dist)(?:[/\\]|$)/.test(src.slice(join(REPO, 'apps/admin').length)),
    })
    const env = {
      ...process.env,
      PATH: [
        join(REPO, 'apps/admin/node_modules/.bin'),
        join(REPO, 'node_modules/.bin'),
        process.env['PATH'],
      ].join(':'),
    }
    const runPrepack = () => spawnSync('sh', ['-c', prepack!], { cwd: copy, env, encoding: 'utf8' })

    const without = runPrepack()
    expect(without.status, `${without.stdout}${without.stderr}`).not.toBe(0)

    mkdirSync(join(copy, 'dist'), { recursive: true })
    writeFileSync(join(copy, 'dist', 'index.html'), '<!doctype html><title>admin</title>')
    const withDist = runPrepack()
    expect(withDist.status, `${withDist.stdout}${withDist.stderr}`).toBe(0)
    expect(without.status).not.toBe(withDist.status)
  })
})
