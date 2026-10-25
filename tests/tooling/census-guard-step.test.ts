import { afterEach, describe, expect, it } from 'vitest'
import { cleanupScratch, gateCli, git, type Scratch, scratchRepo, write } from './scratch-gate'

// AC-4 and AC-5: the census-trend step refuses the tests a change adds or rewrites when they are presence-only (R1),
// mock-call-only (R2) or a constant initial state (R3), and only those: an outcome test beside them is not named, and
// an old test of a refused shape that the change leaves as it was is not judged, so a file can gain a test without
// first paying off its debt. The step is the real `gate.ts census-trend <base>` on a scratch repository.

afterEach(cleanupScratch)

const FILE = 'packages/sdk/src/store/cart-store.test.ts'

const HEADER = "import { describe, expect, it, vi } from 'vitest'\n\n"

const PRESENCE = `it('renders an add button', async () => {
  const el = await createElement()
  expect(shadow(el).querySelector('button')).toBeTruthy()
})
`
const MOCK_CALL = `it('calls logout with the refresh token', async () => {
  const service = makeAuthService()
  await invoke(service, 'POST', '/api/auth/logout', { cookies: { refresh: 'tok' } })
  expect(service.logout).toHaveBeenCalledWith('tok')
})
`
const INITIAL_STATE = `it('initial state is empty', () => {
  const store = createCartStore(makeAdapter())
  expect(store.getState().items).toHaveLength(0)
  expect(store.getState().loading).toBe(false)
})
`
/** An outcome test with a relational assertion, so rule 2 passes the file and only the refused shapes can fail it. */
const OUTCOME = `it('adding a line grows the count by its quantity', () => {
  const store = createCartStore(makeAdapter())
  const before = store.getState().itemCount
  store.add({ variantId: 'v1', qty: 2 })
  expect(store.getState().itemCount).toBe(before + 2)
})
`
const SECOND_OUTCOME = `it('removing the line brings the count back', () => {
  const store = createCartStore(makeAdapter())
  const before = store.getState().itemCount
  store.add({ variantId: 'v1', qty: 2 })
  store.remove('v1')
  expect(store.getState().itemCount).toBe(before)
})
`

/** The `violation:` lines of a run, as `[test name, kind]` pairs for the refused shapes and the raw line otherwise. */
function refusals(output: string): Array<[string, string] | string> {
  return output
    .split('\n')
    .filter((line) => line.startsWith('violation:'))
    .map((line) => {
      const m = /: test "([^"]+)" \(line \d+\): (R[1-3]) /.exec(line)
      return m ? [m[1]!, m[2]!] : line
    })
}

function repoWith(base: Record<string, string>): { repo: Scratch; root: string; base: string } {
  const repo = scratchRepo({
    'package.json': JSON.stringify({ name: 'census-scratch', private: true }),
    ...base,
  })
  return { repo, root: repo.root, base: git(repo.root, 'rev-parse', 'HEAD').trim() }
}

async function trend(
  repo: Scratch,
  base: string,
): Promise<{ code: number | null; output: string }> {
  git(repo.root, 'add', '-A')
  git(repo.root, 'commit', '-q', '-m', 'head')
  const run = await gateCli(repo, ['census-trend', base], {}, false)
  return { code: run.code, output: run.output }
}

describe('AC-4: the step refuses each added test of a refused shape and accepts the outcome test beside them', () => {
  it('a new file with one test of each shape and an outcome test fails on exactly those three', async () => {
    const { repo, root, base } = repoWith({})
    write(root, FILE, HEADER + [PRESENCE, MOCK_CALL, INITIAL_STATE, OUTCOME].join('\n'))

    const run = await trend(repo, base)

    expect(run.output).toMatch(/^census trend against /m)
    expect(refusals(run.output), run.output).toEqual([
      ['renders an add button', 'R1'],
      ['calls logout with the refresh token', 'R2'],
      ['initial state is empty', 'R3'],
    ])
    expect(run.output).toMatch(/e\.g\. expect\(/)
    expect(run.code, run.output).toBe(1)
    // The step's exit status and its refusal lines agree: red exactly when a line names a test.
    expect(run.code === 0, run.output).toBe(refusals(run.output).length === 0)
  })

  it('a new file holding only outcome tests passes', async () => {
    const { repo, root, base } = repoWith({})
    write(root, FILE, HEADER + [OUTCOME, SECOND_OUTCOME].join('\n'))

    const run = await trend(repo, base)

    expect(refusals(run.output), run.output).toEqual([])
    expect(run.code, run.output).toBe(0)
  })
})

describe('AC-5: an old test of a refused shape is judged only when the change rewrites it', () => {
  it('a presence test the change leaves alone is not named when the file gains an outcome test', async () => {
    const { repo, root, base } = repoWith({ [FILE]: HEADER + [PRESENCE, OUTCOME].join('\n') })
    write(root, FILE, HEADER + [PRESENCE, OUTCOME, SECOND_OUTCOME].join('\n'))

    const run = await trend(repo, base)

    expect(run.output).toMatch(/: 1 test file\(s\) touched/)
    expect(refusals(run.output), run.output).toEqual([])
    expect(run.code, run.output).toBe(0)
  })

  it('the same presence test with its body rewritten, still presence, is refused', async () => {
    const { repo, root, base } = repoWith({ [FILE]: HEADER + [PRESENCE, OUTCOME].join('\n') })
    const rewritten = PRESENCE.replace(
      "querySelector('button')",
      'querySelector(\'[data-testid="add"]\')',
    )
    write(root, FILE, HEADER + [rewritten, OUTCOME].join('\n'))

    const run = await trend(repo, base)

    expect(refusals(run.output), run.output).toEqual([['renders an add button', 'R1']])
    expect(run.code, run.output).toBe(1)
    expect(run.code === 0, run.output).toBe(refusals(run.output).length === 0)
  })
})
