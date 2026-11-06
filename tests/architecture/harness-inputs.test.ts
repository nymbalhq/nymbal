// Reads: **
import { matchesGlob } from 'node:path'
import { describe, expect, it } from 'vitest'
import { declaredReads, HARNESS_TEST_GLOBS } from '../../scripts/gate'
import { checkout, type Finding, readsFindings } from './harness-reads'

// Every harness test file says, on `// Reads:` lines, which checkout files it reads or runs outside its imports, so
// that a change to one of them selects it in the plain gate. Its whole verdict rests on the tracked list: any file
// added, moved or removed can change it, hence `**`.

const co = checkout()
const FIXTURES = 'tests/architecture/fixtures/harness-inputs'

/** The two harness projects' test files (vitest.config.ts `include`), fixtures aside, read without the gate's globs. */
const PROJECT_FILE = /^tests\/(?:tooling|architecture)\/(?:.*\/)?[^/]+\.test\.ts$/

describe('AC-6: every harness test declares what it reads', () => {
  it('AC-6: the harness test files are the tooling and architecture projects’ test files outside fixtures/', () => {
    const harness = co.files.filter(
      (p) =>
        HARNESS_TEST_GLOBS.some((g: string) => matchesGlob(p, g)) &&
        !matchesGlob(p, '**/fixtures/**'),
    )
    const projects = co.files.filter((p) => PROJECT_FILE.test(p) && !p.includes('/fixtures/'))
    expect(harness.sort()).toEqual(projects.sort())
    expect(harness).toContain('tests/architecture/harness-inputs.test.ts')
  })

  it('AC-6: each one has a // Reads: line, every glob matches a file, none that reaches the checkout declares nothing, and no tooling test names a product path', () => {
    const harness = co.files.filter(
      (p) =>
        HARNESS_TEST_GLOBS.some((g: string) => matchesGlob(p, g)) &&
        !matchesGlob(p, '**/fixtures/**'),
    )
    const findings = harness.flatMap((file) => readsFindings(co, file, declaredReads))
    expect(findings.map((f) => f.message)).toEqual([])
    expect(harness.length).toBeGreaterThan(findings.length)
  })
})

describe('AC-6: the check is red for each way a declaration goes wrong', () => {
  const CASES: Array<{
    fixture: string
    as?: string
    checks: Finding['check'][]
    names: string[]
  }> = [
    { fixture: 'no-line', checks: ['i'], names: [] },
    {
      fixture: 'dead-glob',
      checks: ['ii'],
      names: ['.github/workflows/no-such-workflow.yml'],
    },
    { fixture: 'nothing-direct', checks: ['iii'], names: ['nothing', 'readFileSync'] },
    { fixture: 'nothing-tracked', checks: ['iii'], names: ['nothing', 'trackedFiles'] },
    { fixture: 'nothing-gate', checks: ['iii'], names: ['nothing', 'gateCli'] },
    { fixture: 'nothing-root', checks: ['iii'], names: ['nothing', 'execFileSync'] },
    { fixture: 'nothing-relative', checks: ['iii'], names: ['nothing', 'readFileSync'] },
    { fixture: 'nothing-no-cwd', checks: ['iii'], names: ['nothing', 'execFileSync'] },
    { fixture: 'nothing-dirname', checks: ['iii'], names: ['nothing', 'readFileSync'] },
    { fixture: 'nothing-url-parent', checks: ['iii'], names: ['nothing', 'readdirSync'] },
    { fixture: 'nothing-url-sibling', checks: ['iii'], names: ['nothing', 'readFileSync'] },
    { fixture: 'nothing-url-template', checks: ['iii'], names: ['nothing', 'readFileSync'] },
    {
      fixture: 'tooling-product',
      as: 'tests/tooling/tooling-product.test.ts',
      checks: ['iv'],
      names: ['packages/platform/src/services/*.ts'],
    },
    { fixture: 'honest', checks: [], names: [] },
    { fixture: 'honest-dot-glob', checks: [], names: [] },
    { fixture: 'honest-nothing', checks: [], names: [] },
  ]

  it('AC-6: a missing line, a glob matching nothing, nothing beside a read (direct, through a helper, from a root with no trailing slash, by a cwd-relative path, by a spawn with no cwd, from import.meta.dirname, from any relative URL on import.meta.url) and a tooling product glob each fail, naming the file and the glob; a ** glob reaches dot-directories', () => {
    const results = CASES.map(({ fixture, as, names }) => {
      const file = `${FIXTURES}/${fixture}.fixture.ts`
      const judged = as ?? file
      const findings = readsFindings(co, file, declaredReads, judged)
      return {
        fixture,
        checks: findings.map((f) => f.check),
        named: findings.every(
          (f) => f.message.includes(judged) && names.every((n) => f.message.includes(n)),
        ),
      }
    })
    expect(results).toEqual(CASES.map(({ fixture, checks }) => ({ fixture, checks, named: true })))
    expect(results.filter((r) => r.checks.length > 0).length).toBe(
      CASES.filter((c) => c.checks.length > 0).length,
    )
  })
})
