import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './workspace-manifests'

// Acceptance test for P0-05 AC-5: one Node for local and CI. `.node-version` names major 26, `pnpm-workspace.yaml`
// makes the `engines` field binding (`engineStrict: true`; pnpm 11+ reads no settings from `.npmrc`), and every
// `actions/setup-node` step reads `.node-version` instead of its own version. The drift this stops: a
// better-sqlite3 built for one Node ABI loaded by another (2026-10-17).

const WORKFLOWS = join(REPO_ROOT, '.github/workflows')

interface SetupNodeStep {
  where: string
  body: string[]
}

const indentOf = (line: string): number => /^ */.exec(line)![0].length
const blank = (line: string): boolean => /^\s*(?:#.*)?$/.test(line)

/** Every `actions/setup-node` step of a workflow, as the lines of its step block. */
function setupNodeSteps(file: string, source: string): SetupNodeStep[] {
  const lines = source.split('\n').map((l) => l.replace(/\r$/, ''))
  const steps: SetupNodeStep[] = []
  lines.forEach((line, i) => {
    if (!/^\s*(?:-\s+)?uses:\s*['"]?actions\/setup-node@/.test(line)) return
    // The step starts at the nearest sequence item at or above the `uses:` key.
    let start = i
    while (start >= 0 && !/^\s*-\s/.test(lines[start]!)) start -= 1
    if (start < 0) throw new Error(`${file}:${i + 1}: setup-node step has no sequence item`)
    const dash = indentOf(lines[start]!)
    let end = start + 1
    while (end < lines.length && (blank(lines[end]!) || indentOf(lines[end]!) > dash)) end += 1
    steps.push({ where: `${file}:${i + 1}`, body: lines.slice(start, end) })
  })
  return steps
}

describe('AC-5: a pinned Node, strict engines, and CI reading the pin', () => {
  it('AC-5: .node-version exists and names major 26', () => {
    const file = join(REPO_ROOT, '.node-version')
    expect(existsSync(file), '.node-version at the repository root').toBe(true)
    const first = readFileSync(file, 'utf8').split('\n')[0]!.trim()
    expect(first).toMatch(/^v?26(?:\.\d+){0,2}$/)
  })

  it('AC-5: pnpm-workspace.yaml sets engineStrict: true', () => {
    const engineStrict = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8')
      .split('\n')
      .map((l) => /^engineStrict:\s*([^#\s]*)/.exec(l)?.[1])
      .filter((v) => v !== undefined)
    expect(engineStrict).toEqual(['true'])
  })

  it('AC-5: every actions/setup-node step in .github/workflows/*.yml uses node-version-file: .node-version', () => {
    const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f))
    const steps = files.flatMap((f) =>
      setupNodeSteps(`.github/workflows/${f}`, readFileSync(join(WORKFLOWS, f), 'utf8')),
    )
    // The reader found the steps: ci.yml alone has several.
    expect(steps.length).toBeGreaterThanOrEqual(files.length)
    const reading = steps.filter(
      (s) =>
        s.body.some((l) =>
          /^\s*node-version-file:\s*['"]?\.node-version['"]?\s*(?:#.*)?$/.test(l),
        ) && !s.body.some((l) => /^\s*node-version:/.test(l)),
    )
    expect(
      steps.filter((s) => !reading.includes(s)).map((s) => s.where),
      'setup-node steps that do not read .node-version (or also pass node-version)',
    ).toEqual([])
    expect(reading.length).toBe(steps.length)
  })
})
