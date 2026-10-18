import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Step } from '../../scripts/gate'
import {
  ARTEFACT,
  cleanupScratch,
  GATE_PACKAGE_JSON,
  gateCli,
  scratchRepo,
  STRYKER_CONFIG,
  write,
} from './scratch-gate'

// Acceptance tests for P1-17 (spec P1-17-loop-asks-what-user-sees), AC-9 and the gate half of AC-10: an E2E step
// checks, before Playwright starts, that the build output it serves exists, and it is red when the E2E server
// wrapper left reports/e2e-shutdown.json behind. The real gate.ts runs `--full --only "e2e admin" --no-build` in a
// scratch repository whose artefact `artefactPresent` accepts; Playwright and pnpm are stand-ins that log each call
// (scratch-gate.ts), so "Playwright started" is read from that log.

afterEach(cleanupScratch)

const ARGS = ['--full', '--only', 'e2e admin', '--no-build', '--base', 'HEAD', '--json']
const step = (steps: Step[], name: string): Step | undefined => steps.find((s) => s.name === name)

function artefactRepo(withIndex: boolean): ReturnType<typeof scratchRepo> {
  const files: Record<string, string> = {
    'package.json': GATE_PACKAGE_JSON,
    'stryker.config.mjs': STRYKER_CONFIG,
    ...ARTEFACT,
  }
  if (!withIndex) {
    delete files['apps/admin/dist/index.html']
    // apps/admin/dist/ exists, so artefactPresent still passes; only the page the API serves is missing.
    files['apps/admin/dist/assets/index-abc123.js'] = 'export {}\n'
  }
  return scratchRepo(files)
}

describe('AC-9: an E2E step whose served output is missing is red before Playwright starts', () => {
  it('AC-9: apps/admin/dist without index.html: e2e admin goes red in under 5 s, names the path, and spawns no Playwright', async () => {
    const repo = artefactRepo(false)
    const run = await gateCli(repo, ARGS)
    const admin = step(run.steps, 'e2e admin')
    const playwright = repo.calls().filter((call) => /playwright/.test(call))

    expect(admin?.status, run.output).toBe('red')
    expect(admin?.ms ?? Infinity, run.output).toBeLessThan(5000)
    expect(run.output).toContain('apps/admin/dist/index.html')
    expect(playwright, run.output).toEqual([])
    expect(run.code, run.output).toBe(1)
  })
})

describe('AC-10: the E2E step is red when the server wrapper recorded a hang, and only then', () => {
  const COMMAND = 'node packages/cli/bin/nymbal.mjs dev --api-only'

  it('AC-10: Playwright leaves reports/e2e-shutdown.json: the step goes red naming the command', async () => {
    const repo = artefactRepo(true)
    const run = await gateCli(repo, ARGS, { FAKE_SHUTDOWN_COMMAND: COMMAND })
    // The stand-in did run Playwright, and it did leave the file.
    expect(repo.calls().filter((call) => /playwright/.test(call)).length).toBeGreaterThan(0)
    expect(step(run.steps, 'e2e admin')?.status, run.output).toBe('red')
    expect(run.output).toContain(COMMAND)
    expect(run.code, run.output).toBe(1)
  })

  it('AC-10: a file left by an earlier run is deleted before the step, so a clean exit is not flagged', async () => {
    const repo = artefactRepo(true)
    write(
      repo.root,
      'reports/e2e-shutdown.json',
      JSON.stringify({ command: COMMAND, pid: 1, waitedMs: 5000 }),
    )
    const run = await gateCli(repo, ARGS)
    expect(repo.calls().filter((call) => /playwright/.test(call)).length).toBeGreaterThan(0)
    expect(step(run.steps, 'e2e admin')?.status, run.output).toBe('ok')
    expect(existsSync(join(repo.root, 'reports/e2e-shutdown.json')), run.output).toBe(false)
    rmSync(join(repo.root, 'reports'), { recursive: true, force: true })
  })
})
