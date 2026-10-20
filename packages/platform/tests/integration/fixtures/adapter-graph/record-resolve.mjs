// Module hooks for the P2-01 AC-2 and AC-7 child process (adapter-graph.test.ts). Every URL the process resolves is
// appended to `out`. A specifier in `hide` is not found, with the error Node itself raises for a package that is not
// installed. A package in `poison` resolves but throws while it evaluates: a broken SDK, not a missing one.
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let out = ''
let hide = []
let poison = []

export function initialize(data) {
  out = data.out
  hide = data.hide ?? []
  poison = data.poison ?? []
}

export async function resolve(specifier, context, nextResolve) {
  if (hide.includes(specifier)) {
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : '<entry>'
    const error = new Error(`Cannot find package '${specifier}' imported from ${parent}`)
    error.code = 'ERR_MODULE_NOT_FOUND'
    throw error
  }
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
