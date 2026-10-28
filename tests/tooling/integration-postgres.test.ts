// Reads: packages/platform/tests/postgres/**, vitest.config.ts
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// AC-9: the `integration-postgres` Vitest project fails, never skips or passes, when NYMBAL_TEST_POSTGRES_URL is
// missing, and the failure names the variable. One file run without the variable shows how a file fails; every file
// in the project fails the same way because each reads the variable through postgresServerUrl() as it loads.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const URL_VAR = 'NYMBAL_TEST_POSTGRES_URL'
const PROJECT_DIR = 'packages/platform/tests/postgres'
/** Left out of integration-postgres by vitest.config.ts; integration-postgres-perf runs it. */
const PERF = `${PROJECT_DIR}/search-performance.postgres.test.ts`
const SAMPLE = `${PROJECT_DIR}/audit-entries.postgres.test.ts`

function envWithout(...names: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (names.includes(key) || key.startsWith('VITEST')) continue
    env[key] = value
  }
  return env
}

/** The files the project's include glob (`<dir>/**\/*.test.ts`) selects, repository-relative. */
function projectFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(REPO, dir))) {
      const path = `${dir}/${entry}`
      if (statSync(join(REPO, path)).isDirectory()) walk(path)
      else if (entry.endsWith('.test.ts')) out.push(path)
    }
  }
  walk(PROJECT_DIR)
  return out.filter((p) => p !== PERF).sort()
}

/** Whether a statement at the module's top level calls postgresServerUrl() (as `const url = postgresServerUrl()` does). */
function readsTheVariableOnLoad(path: string): boolean {
  const source = ts.createSourceFile(
    path,
    readFileSync(join(REPO, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const calls = (node: ts.Node): boolean =>
    (ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'postgresServerUrl') ||
    (!ts.isFunctionLike(node) &&
      ts.forEachChild(node, (child) => (calls(child) ? true : undefined)) === true)
  return source.statements.some(
    (statement) =>
      !ts.isImportDeclaration(statement) &&
      !ts.isFunctionDeclaration(statement) &&
      calls(statement),
  )
}

describe('AC-9: integration-postgres without its database', () => {
  it('AC-9: a project file run without NYMBAL_TEST_POSTGRES_URL fails, not skips, with a message naming the variable', () => {
    const result = spawnSync(
      'pnpm',
      ['exec', 'vitest', 'run', '--project', 'integration-postgres', SAMPLE],
      { cwd: REPO, encoding: 'utf8', env: envWithout(URL_VAR), timeout: 50_000 },
    )
    const out = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '')
    expect(result.status, out).not.toBe(0)
    expect(out).toContain(URL_VAR)
    const files = /Test Files\s+(\d+) failed \((\d+)\)/.exec(out)
    expect(files?.slice(1).map(Number), out).toEqual([1, 1])
  })

  it('AC-9: every file in the project reads the variable through postgresServerUrl() as it loads, so each fails without it', () => {
    const files = projectFiles()
    expect(files).toContain(SAMPLE)
    expect(files.filter((path) => !readsTheVariableOnLoad(path))).toEqual([])
    expect(files.filter(readsTheVariableOnLoad)).toEqual(projectFiles())
  })
})
