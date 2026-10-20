// Module hooks for the P2-01 AC-2 and AC-7 child process (adapter-graph.test.ts). Every URL the process resolves is
// appended to `out`. A specifier in `hide` is resolved as if imported from an empty directory beside `out` (the test's
// scratch directory, with no node_modules above it), so Node itself raises the error it raises for a package that is
// not installed. A package in `poison` resolves but throws while it evaluates: a broken SDK, not a missing one.
import { appendFileSync, mkdtempSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

let out = ''
let hide = []
let poison = []
let nowhere = ''

export function initialize(data) {
  out = data.out
  hide = data.hide ?? []
  poison = data.poison ?? []
  nowhere = pathToFileURL(join(mkdtempSync(join(dirname(out), 'nowhere-')), 'x.mjs')).href
}

export async function resolve(specifier, context, nextResolve) {
  if (hide.includes(specifier)) return nextResolve(specifier, { ...context, parentURL: nowhere })
  const result = await nextResolve(specifier, context)
  appendFileSync(out, `${result.url}\n`)
  return result
}

export async function load(url, context, nextLoad) {
  const name = poison.find((p) => url.includes(`/node_modules/${p}/`))
  if (name !== undefined) {
    // CommonJS links whatever names the importer asks for, so the throw happens at evaluation, as a broken SDK's would.
    return {
      format: 'commonjs',
      shortCircuit: true,
      source: `throw new Error('p2-01 poisoned ${name}')\n`,
    }
  }
  return nextLoad(url, context)
}
