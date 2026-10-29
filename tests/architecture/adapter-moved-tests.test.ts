// Reads: vitest.config.ts, packages/**
import { execFile } from 'node:child_process'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { MOVED_ADAPTERS, ROOT } from './adapter-table'

// AC-5, the counts: the tests of the twelve moved with them, as renames, so this is their only proof. For each
// package, the Vitest projects collect at its new directory exactly the test files it had at its old one (the base
// plus the SES provider's), each in the project that ran it before: none dropped, none added, none left behind.

const exec = promisify(execFile)

/** Every file `vitest list --filesOnly` collects over every project, repo-relative, with the project of each. */
async function collected(): Promise<Array<{ file: string; project: string }>> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('VITEST') && !key.startsWith('NYMBAL_')) env[key] = value
  }
  const { stdout } = await exec(
    join(ROOT, 'node_modules/.bin/vitest'),
    ['list', '--filesOnly', '--json'],
    { cwd: ROOT, env, maxBuffer: 64 * 1024 * 1024 },
  )
  return (
    JSON.parse(stdout.slice(stdout.indexOf('['))) as Array<{ file: string; projectName?: string }>
  ).map((row) => ({
    file: relative(ROOT, row.file).split('\\').join('/'),
    project: row.projectName ?? '',
  }))
}

describe('AC-5: the moved tests still run', () => {
  it('AC-5: each of the twelve has, at its new directory, exactly the test files it had, in the same projects', async () => {
    const rows = await collected()
    const wrong = MOVED_ADAPTERS.flatMap((a) => {
      const expected = a.tests.map(([file, project]) => `${project} ${file}`).sort()
      const got = rows
        .filter((r) => r.file.startsWith(`${a.dir}/`))
        .map((r) => `${r.project} ${r.file.slice(a.dir.length + 1)}`)
        .sort()
      return JSON.stringify(got) === JSON.stringify(expected)
        ? []
        : [`${a.dir}: collected [${got.join(', ')}], expected [${expected.join(', ')}]`]
    })
    const left = rows.filter((r) => MOVED_ADAPTERS.some((a) => r.file.startsWith(`${a.from}/`)))

    expect(wrong).toEqual([])
    expect(left.map((r) => r.file)).toEqual([])
    expect(rows.filter((r) => r.file.startsWith('packages/adapters/')).length).toBe(
      MOVED_ADAPTERS.reduce((sum, a) => sum + a.tests.length, 0),
    )
  }, 60_000)
})
