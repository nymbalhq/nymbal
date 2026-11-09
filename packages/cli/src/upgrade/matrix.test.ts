import { createServer, type Server } from 'node:http'
import fc from 'fast-check'
import semver from 'semver'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchMatrix, type Matrix, MatrixError, parseMatrix } from './matrix.js'

const ADAPTER = '@acme/nymbal-search'

function wellFormed(): Matrix {
  return {
    schema: 1,
    generatedAt: '2026-11-09T03:00:00.000Z',
    stacks: {
      '1.9.0': {
        packages: { nymbal: '1.9.0', '@nymbalhq/platform': '1.9.0' },
        adapters: {
          [ADAPTER]: { version: '2.0.0', status: 'passing', line: '30 cases passed' },
          '@acme/could-not-install': { version: null, status: 'failing', line: 'install failed' },
          '@acme/gone': { version: null, status: 'suspended' },
          '@nymbalhq/search-typesense': { version: '1.2.0', status: 'first-party' },
          '@acme/no-suite': { version: '0.3.0', status: 'no-suite' },
        },
      },
    },
  }
}

const withStack = (key: string): unknown => {
  const m = wellFormed()
  return { ...m, stacks: { [key]: m.stacks['1.9.0'] } }
}

const withPackage = (value: unknown): unknown => {
  const m = wellFormed()
  ;(m.stacks['1.9.0']!.packages as Record<string, unknown>)['nymbal'] = value
  return m
}

const withAdapter = (entry: unknown): unknown => {
  const m = wellFormed()
  ;(m.stacks['1.9.0']!.adapters as Record<string, unknown>)[ADAPTER] = entry
  return m
}

/** The error parseMatrix throws for `value`; a value it accepts fails the caller's instance check. */
function refusal(value: unknown): unknown {
  try {
    return parseMatrix(value)
  } catch (err) {
    return err
  }
}

describe('AC-6: every field of a fetched matrix is checked before anything is written from it', () => {
  it.each([
    { name: 'a non-object', value: 'matrix', field: /./ },
    { name: 'null', value: null, field: /./ },
    { name: 'an array', value: [], field: /./ },
    { name: 'schema 2', value: { ...wellFormed(), schema: 2 }, field: /schema/ },
    { name: 'a file: stack key', value: withStack('file:../x'), field: /file:\.\.\/x|stacks/ },
    { name: 'a git stack key', value: withStack('git+https://x'), field: /git\+https|stacks/ },
    { name: 'a file: package value', value: withPackage('file:../x'), field: /nymbal|packages/ },
    { name: 'a git package value', value: withPackage('git+https://x'), field: /nymbal|packages/ },
    {
      name: 'a file: adapter version',
      value: withAdapter({ version: 'file:../x', status: 'passing' }),
      field: /version|acme/,
    },
    {
      name: 'a git adapter version',
      value: withAdapter({ version: 'git+https://x', status: 'failing' }),
      field: /version|acme/,
    },
    {
      name: 'an unknown status',
      value: withAdapter({ version: '1.0.0', status: 'fine' }),
      field: /status/,
    },
    {
      name: 'a null version on a passing adapter',
      value: withAdapter({ version: null, status: 'passing' }),
      field: /version/,
    },
    {
      name: 'a null version on a first-party adapter',
      value: withAdapter({ version: null, status: 'first-party' }),
      field: /version/,
    },
    {
      name: 'a null version on a no-suite adapter',
      value: withAdapter({ version: null, status: 'no-suite' }),
      field: /version/,
    },
  ])('AC-6: $name is a MatrixError naming the field', ({ value, field }) => {
    const err = refusal(value)

    expect(err).toBeInstanceOf(MatrixError)
    expect((err as MatrixError).message).toMatch(field)
  })

  it('AC-6: a well-formed matrix is accepted, null versions included where the status allows them', () => {
    const matrix = wellFormed()

    expect(parseMatrix(JSON.parse(JSON.stringify(matrix)))).toEqual(matrix)
  })

  it('AC-6: any string that is not semver, in any version field, is a MatrixError', () => {
    const notSemver = fc.string().filter((s) => semver.valid(s) === null)
    fc.assert(
      fc.property(notSemver, (value) => {
        for (const bad of [
          withStack(value),
          withPackage(value),
          withAdapter({ version: value, status: 'passing' }),
        ]) {
          expect(refusal(bad)).toBeInstanceOf(MatrixError)
        }
      }),
    )
  })
})

describe('AC-8: a matrix server that never answers cannot hang the command', () => {
  let server: Server | undefined

  afterEach(async () => {
    const open = server
    server = undefined
    if (open === undefined) return
    open.closeAllConnections()
    await new Promise<void>((resolve) => open.close(() => resolve()))
  })

  it('AC-8: fetchMatrix rejects with a MatrixError within its timeoutMs against a server that accepts and never replies', async () => {
    const timeoutMs = 150
    const silent = createServer(() => {})
    server = silent
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const { port } = silent.address() as { port: number }

    const started = performance.now()
    const result = await fetchMatrix(`http://127.0.0.1:${port}/matrix.json`, { timeoutMs }).catch(
      (err: unknown) => err,
    )
    const elapsed = performance.now() - started

    expect(result).toBeInstanceOf(MatrixError)
    // The margin is for the runner's load; the default bound is 10 000 ms, which this would miss by far.
    expect(elapsed).toBeLessThan(timeoutMs + 3000)
  })
})
