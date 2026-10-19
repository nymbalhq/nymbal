import { execFile, execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { REPO, TSX } from './scratch-gate'

// Acceptance test for P1-17 (spec P1-17-loop-asks-what-user-sees), AC-15: `scripts/sentinels.ts --only` takes a
// comma-separated list and runs exactly those sentinels; an unknown id exits 1 before anything runs. The repository
// is the sentinels-exit fixture (a module, a `node --test` suite) with three copies of its caught sentinel, renamed
// I101, S001 and I102. The suite appends to a log outside the tree each time it runs, so "ran" is read from there.

const FIXTURES = join(REPO, 'tests/tooling/fixtures/sentinels-exit')
const created: string[] = []
afterAll(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

function fixtureRepo(): { root: string; dir: string; log: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-sentinels-only-')))
  created.push(base)
  const root = join(base, 'repo')
  const dir = join(root, 'sentinels')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'test'), { recursive: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'sentinels-only-fixture', private: true, type: 'module' })}\n`,
  )
  copyFileSync(join(FIXTURES, 'math.js.fixture'), join(root, 'src/math.js'))
  copyFileSync(join(FIXTURES, 'math.test.js.fixture'), join(root, 'test/math.test.js'))
  const caught = readFileSync(join(FIXTURES, 'I001-caught.patch'), 'utf8')
  for (const id of ['I101', 'S001', 'I102']) {
    writeFileSync(join(dir, `${id}-caught.patch`), caught.replace(/^# id: I001$/m, `# id: ${id}`))
  }
  execFileSync(
    'git',
    [
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.test',
      '-c',
      'commit.gpgsign=false',
      'init',
      '-q',
      '-b',
      'main',
    ],
    { cwd: root, stdio: 'ignore' },
  )
  for (const args of [
    ['add', '-A'],
    ['commit', '-q', '-m', 'fixture'],
  ]) {
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.test',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: root, stdio: 'ignore' },
    )
  }
  return { root, dir, log: join(base, 'suite-runs.log') }
}

function sentinels(
  repo: { root: string; dir: string; log: string },
  only: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const suite = `echo run >> '${repo.log}' && node --test`
  return new Promise((resolve) => {
    execFile(
      TSX,
      [
        'scripts/sentinels.ts',
        '--root',
        repo.root,
        '--dir',
        repo.dir,
        '--suite',
        suite,
        '--only',
        only,
        '--json',
      ],
      { cwd: REPO, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1
        resolve({ code, stdout, stderr })
      },
    )
  })
}

const runs = (log: string): number =>
  existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0

describe('AC-15: sentinels.ts --only takes a list', () => {
  it('AC-15: --only I101,S001 runs exactly those two; --only I101,NOPE exits 1 naming NOPE and runs nothing', async () => {
    const listed = fixtureRepo()
    const run = await sentinels(listed, 'I101,S001')
    expect(run.code, run.stderr).toBe(0)
    const report = JSON.parse(run.stdout) as { sentinels: Array<{ id: string; status: string }> }
    expect(report.sentinels.map((s) => s.id).sort()).toEqual(['I101', 'S001'])
    // The control plus one suite run per selected sentinel: I102's patch was never applied.
    expect(runs(listed.log)).toBe(report.sentinels.length + 1)

    const typo = fixtureRepo()
    const bad = await sentinels(typo, 'I101,NOPE')
    expect(bad.code).toBe(1)
    expect(bad.stderr).toMatch(/\bNOPE\b/)
    expect(runs(typo.log)).toBe(0)
  })
})
