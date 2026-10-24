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

// AC-2: `nymbal dev --api-only` prints its summary once and no debug lines until `--verbose` or LOG_LEVEL=debug asks
// for them. Needs `pnpm build`.

/** The window: the projections a first GET sets off log within it. */
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
  const dir = mkdtempSync(join(tmpdir(), 'nymbal-doctor-dev-'))
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

describe('AC-2: nymbal dev starts quietly with one summary', () => {
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
