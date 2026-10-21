import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import repoConfig from '../../../../nymbal.config.js'
import {
  cliEnv,
  commerceSlots,
  DEBUG_LINE,
  linesNaming,
  onDefaultStores,
  REPO_ROOT,
  startDev,
  type DevRun,
} from '../../../../tests/support/doctor.js'

// Acceptance test for P2-09 AC-2 (spec P2-09-dev-stage, decisions 1 and 2): `nymbal dev --api-only`, the built CLI on
// the repository's config (SQLite, a fresh file, a free port). Its output from start until 2 s after a GET
// /api/products holds the summary exactly once (one line per commerce slot naming its provider, and the one `--verbose`
// hint) and no DEBUG or level-20 line. With `--verbose`, or with LOG_LEVEL=debug and no flag, the same run still prints
// the summary and at least one DEBUG line. Kills: dev still logging at debug, a missing or doubled summary, a
// `--verbose` that does nothing, a LOG_LEVEL that is ignored. Needs `pnpm build`.

/** The spec's window: the projections a first GET sets off log within it. */
const AFTER_REQUEST_MS = 2000

const SLOTS = commerceSlots(onDefaultStores(repoConfig))

let dirs: string[] = []
let runs: DevRun[] = []

afterEach(async () => {
  for (const run of runs.splice(0)) await run.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** dev's output from its start until AFTER_REQUEST_MS after a GET /api/products answered. */
async function devOutput(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'nymbal-p2-09-dev-'))
  dirs.push(dir)
  const run = await startDev(args, {
    cwd: REPO_ROOT,
    env: cliEnv({ NYMBAL_SQLITE_PATH: join(dir, 'nymbal.db'), ...extraEnv }),
  })
  runs.push(run)
  const res = await fetch(`${run.base}/api/products`, { signal: AbortSignal.timeout(10_000) })
  expect(res.status, 'GET /api/products').toBe(200)
  await new Promise((r) => setTimeout(r, AFTER_REQUEST_MS))
  return run.output()
}

const debugLines = (out: string) => out.split('\n').filter((l) => DEBUG_LINE.test(l))

describe('P2-09 AC-2: nymbal dev starts quietly with one summary', () => {
  it('AC-2: with no flag and no LOG_LEVEL, the output holds the summary exactly once and no DEBUG or level-20 line', async () => {
    const out = await devOutput([])

    expect(debugLines(out), out.slice(-3000)).toEqual([])
    for (const { slot, provider } of SLOTS) {
      expect(
        linesNaming(out, slot, provider),
        `${slot} ${provider}\n${out.slice(-3000)}`,
      ).toHaveLength(1)
    }
    expect(out.split('--verbose').length - 1, 'the --verbose hint, once').toBe(1)
  }, 90_000)

  it('AC-2: with --verbose, the run prints the summary and at least one DEBUG line', async () => {
    const out = await devOutput(['--verbose'])

    expect(debugLines(out).length, out.slice(-3000)).toBeGreaterThan(0)
    for (const { slot, provider } of SLOTS) {
      expect(linesNaming(out, slot, provider).length, `${slot} ${provider}`).toBeGreaterThanOrEqual(
        1,
      )
    }
    expect(
      out.split('--verbose').length - 1,
      "the summary's --verbose hint",
    ).toBeGreaterThanOrEqual(1)
  }, 90_000)

  it('AC-2: with LOG_LEVEL=debug and no flag, the run prints the summary and at least one DEBUG line', async () => {
    const out = await devOutput([], { LOG_LEVEL: 'debug' })

    expect(debugLines(out).length, out.slice(-3000)).toBeGreaterThan(0)
    for (const { slot, provider } of SLOTS) {
      expect(linesNaming(out, slot, provider).length, `${slot} ${provider}`).toBeGreaterThanOrEqual(
        1,
      )
    }
    expect(
      out.split('--verbose').length - 1,
      "the summary's --verbose hint",
    ).toBeGreaterThanOrEqual(1)
  }, 90_000)
})
