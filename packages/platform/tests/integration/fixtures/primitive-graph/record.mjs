// Module hooks for the P2-02 AC-5 child process (primitive-graph tests). Every resolution is appended to `out` as one
// JSON line, { specifier, parent, url }, so a test can tell who imported a package and not only that it was loaded. A
// specifier in `hide` resolves as if imported from an empty directory beside `out` (no node_modules above it), so Node
// raises the error it raises for a package that is not installed.
import { appendFileSync, mkdtempSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

let out = ''
let hide = []
let nowhere = ''

export function initialize(data) {
  out = data.out
  hide = data.hide ?? []
  nowhere = pathToFileURL(join(mkdtempSync(join(dirname(out), 'nowhere-')), 'x.mjs')).href
}

export async function resolve(specifier, context, nextResolve) {
  if (hide.includes(specifier)) return nextResolve(specifier, { ...context, parentURL: nowhere })
  const result = await nextResolve(specifier, context)
  appendFileSync(
    out,
    `${JSON.stringify({ specifier, parent: context.parentURL ?? null, url: result.url })}\n`,
  )
  return result
}
