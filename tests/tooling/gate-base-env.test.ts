// Reads: scripts/mutation-ratchet.ts, tests/tooling/gate-ratchet.test.ts
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { changedFiles, plan, selectTests } from '../../scripts/gate'
import { gitIn, REPO, removeCopies, shell, workTreeCopy } from './work-tree-copy'

// CI exports GATE_BASE, the pushed branch's previous tip, to every step. A script that reads it went red only in dev
// CI: in the tooling tests' scratch repositories that sha names no commit. The plain gate's tests step runs with the
// same variable, so the same script goes red here first. The change below is shaped like the one that escaped: the
// root package.json and the script, which selects every test.

const SCRIPT = 'scripts/mutation-ratchet.ts'
/** The commit whose mutation-ratchet.ts took its base from GATE_BASE whatever the ratchet it checked. */
const ESCAPED = '223487b'
const NARROW = 'tests/tooling/gate-ratchet.test.ts'

afterAll(removeCopies)

describe('AC-7: the plain gate runs its tests with the base CI exports', () => {
  it('AC-7: through Vitest, the plain gate’s tests step fails on the script that read GATE_BASE in CI, naming the base that does not resolve, and passes on the fixed one', async () => {
    const dir = workTreeCopy()
    const base = gitIn(dir, 'rev-parse', 'HEAD').trim()
    writeFileSync(join(dir, SCRIPT), gitIn(REPO, 'show', `${ESCAPED}:${SCRIPT}`))
    appendFileSync(join(dir, 'package.json'), '\n')
    const changed = changedFiles(dir, base)
    expect(changed).toEqual(['package.json', SCRIPT])
    expect(selectTests(changed).mode).toBe('all')

    const step = plan({ full: false, base, changed, mutated: [] }).steps.find(
      (s) => s.name === 'tests',
    )
    const [first = '', ...rest] = (step?.command ?? '').split(' && ')
    const narrowed = [`${first} ${NARROW}`, ...rest].join(' && ')

    const escaped = await shell(dir, narrowed)
    expect(escaped.code, escaped.output.slice(-3000)).not.toBe(0)
    expect(escaped.output).toContain(`--base ${base} does not resolve`)

    gitIn(dir, 'checkout', '--', SCRIPT)
    const fixed = await shell(dir, narrowed)
    expect(fixed.code, fixed.output.slice(-3000)).toBe(0)
    expect(fixed.output).not.toContain(`--base ${base} does not resolve`)
    // The script alone decides it: the same command, the same base, only the script differs.
    expect(fixed.code).toBeLessThan(escaped.code)
  }, 300_000)
})
