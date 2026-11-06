// Reads: package.json, tsconfig.json, tsconfig.base.json, packages/**
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './workspace-manifests'

// A package's tests are type-checked by the typecheck the gate runs (`pnpm typecheck`, whose `tsc -b` builds the root
// project and its references). Vitest strips types, so a test outside every built project meets a changed signature
// only at run time, as a required field added to a kernel type once did in the platform's integration tests.

/** The tsconfig files `tsc -b` builds in the root `typecheck` script, references followed. */
function builtProjects(): string[] {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  const projects = new Set<string>()
  for (const command of manifest.scripts['typecheck']!.split('&&')) {
    const words = command.trim().split(/\s+/)
    if (words[0] !== 'tsc' || !words.includes('-b')) continue
    const named = words.slice(1).filter((w) => !w.startsWith('-'))
    const queue = (named.length > 0 ? named : ['tsconfig.json']).map((p) => resolve(REPO_ROOT, p))
    while (queue.length > 0) {
      const at = queue.shift()!
      const file = at.endsWith('.json') ? at : join(at, 'tsconfig.json')
      if (projects.has(file)) continue
      projects.add(file)
      const { config } = ts.readConfigFile(file, ts.sys.readFile)
      for (const ref of (config?.references ?? []) as Array<{ path: string }>) {
        queue.push(resolve(dirname(file), ref.path))
      }
    }
  }
  return [...projects]
}

function filesOf(project: string): string[] {
  const { config } = ts.readConfigFile(project, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(project))
  return parsed.fileNames.map((f) => relative(REPO_ROOT, f))
}

/** Tracked TypeScript test files under packages/: a tests/ or test/ tree, or a *.test.ts beside the source. */
function packageTestFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', 'packages'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((p) => /\.tsx?$/.test(p) && !p.endsWith('.d.ts'))
    .filter((p) => /\/tests?\//.test(p) || /\.test\.tsx?$/.test(p))
}

describe('the gate type-checks every package test', () => {
  it('every tracked test file under packages/ is in a project the root typecheck builds', () => {
    const projects = builtProjects()
    expect(projects.map((p) => relative(REPO_ROOT, p))).toContain('tsconfig.json')
    const checked = new Set(projects.flatMap(filesOf))
    const tests = packageTestFiles()
    const unchecked = tests.filter((p) => !checked.has(p))

    expect(unchecked, `not type-checked by pnpm typecheck:\n${unchecked.join('\n')}`).toEqual([])
    expect(tests.filter((p) => checked.has(p)).length).toBe(tests.length)
    // The platform's integration tree is where the gap was seen: it is part of what the test reads.
    expect(
      tests.filter((p) => p.startsWith('packages/platform/tests/integration/')).length,
    ).toBeGreaterThan(100)
  })
})
