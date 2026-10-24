import { execFile, execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// AC-6: `scripts/sentinels.ts` exits 1 when an injected sentinel is missed or the control is red, and 0 when every one
// is caught, printing the report either way.
// Each case is a throwaway git repo built from tests/tooling/fixtures/sentinels-exit: a module, a `node --test` suite
// that reads only `add`, I001 (breaks `add`: caught) and I002 (changes `untested`, which no test reads: missed).

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const FIXTURES = join(REPO, 'tests/tooling/fixtures/sentinels-exit')
const TSX = join(REPO, 'node_modules/.bin/tsx')
const SUITE = 'node --test'

const created: string[] = []
afterAll(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: 'ignore' },
  )
}

type Fixture = { sentinels: Array<'I001-caught' | 'I002-missed'>; controlRed?: boolean }

function fixtureRepo(f: Fixture): { root: string; dir: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-sentinels-exit-')))
  created.push(base)
  const root = join(base, 'repo')
  const dir = join(root, 'sentinels')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'test'), { recursive: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'sentinels-exit-fixture', private: true, type: 'module' })}\n`,
  )
  copyFileSync(join(FIXTURES, 'math.js.fixture'), join(root, 'src/math.js'))
  const suite = readFileSync(join(FIXTURES, 'math.test.js.fixture'), 'utf8')
  writeFileSync(
    join(root, 'test/math.test.js'),
    f.controlRed === true ? suite.replace('add(2, 3), 5', 'add(2, 3), 6') : suite,
  )
  for (const s of f.sentinels) copyFileSync(join(FIXTURES, `${s}.patch`), join(dir, `${s}.patch`))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'fixture')
  return { root, dir }
}

function sentinels(
  repo: { root: string; dir: string },
  extra: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      TSX,
      ['scripts/sentinels.ts', '--root', repo.root, '--dir', repo.dir, '--suite', SUITE, ...extra],
      { cwd: REPO, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1
        resolve({ code, stdout, stderr })
      },
    )
  })
}

type JsonReport = {
  control: string
  sentinels: Array<{ id: string; status: string }>
  summary: { injected: { caught: number; total: number } }
}

describe('AC-6: a missed sentinel fails the run', () => {
  it('AC-6: a missed injected sentinel exits 1 after printing the report, as text and as --json', async () => {
    const both: Fixture = { sentinels: ['I001-caught', 'I002-missed'] }
    const [text, json] = await Promise.all([
      sentinels(fixtureRepo(both)),
      sentinels(fixtureRepo(both), ['--json']),
    ])

    expect(text.stdout, text.stderr).toMatch(/\| I002 \| injected \| missed \|/)
    expect(text.stdout).toContain('Injected: 1/2 caught')
    expect(text.code, `${text.stdout}\n${text.stderr}`).toBe(1)

    const report = JSON.parse(json.stdout) as JsonReport
    const missed = report.sentinels.filter((s) => s.status === 'missed').map((s) => s.id)
    expect(missed).toEqual(['I002'])
    expect(report.summary.injected.caught).toBeLessThan(report.summary.injected.total)
    expect(json.code, json.stdout).toBe(1)
  })

  it('AC-6: the exit status is 0 iff the control is green and every injected sentinel is caught', async () => {
    const CASES: Array<Fixture & { name: string }> = [
      { name: 'every injected sentinel caught', sentinels: ['I001-caught'] },
      { name: 'one injected sentinel missed', sentinels: ['I001-caught', 'I002-missed'] },
      { name: 'the control red', sentinels: ['I001-caught'], controlRed: true },
    ]
    const results = await Promise.all(CASES.map((c) => sentinels(fixtureRepo(c))))
    const detail = results
      .map((r, i) => `${CASES[i]!.name}: exit ${r.code}\n${r.stdout}${r.stderr}`)
      .join('\n')

    expect(results[0]!.stdout, 'the all-caught run prints its report').toContain(
      'Injected: 1/1 caught',
    )
    expect(
      results.map((r) => r.code === 0),
      detail,
    ).toEqual(CASES.map((c) => c.controlRed !== true && !c.sentinels.includes('I002-missed')))
    for (const [i, r] of results.entries()) {
      expect([0, 1], `${CASES[i]!.name} exits 0 or 1, never a crash code`).toContain(r.code)
    }
  })
})
