import type { Recipe } from '@nymbalhq/types'

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** `NAME=` or `# NAME=`: a variable the file already lists, set or commented out. */
function declares(lines: string[], name: string): boolean {
  const re = new RegExp(`^(#\\s*)?${escapeRegExp(name)}=`)
  return lines.some((line) => re.test(line.trim()))
}

/** The recipe's variables `example` does not list, each once. */
export function missingEnv(example: string, recipe: Recipe): Recipe['env'] {
  const lines = example.split(/\r?\n/)
  return recipe.env.filter(
    (v, i) => !declares(lines, v.name) && recipe.env.findIndex((w) => w.name === v.name) === i,
  )
}

/**
 * `example` (a `.env.example`) with every variable of the recipe it does not list yet appended under a
 * `# <recipe> (nymbal add <recipe>)` header, each with its comment above it; an optional one is commented out.
 * No line is removed or moved, and a file that lists them all is returned as it is.
 */
export function appendRecipeEnv(example: string, recipe: Recipe): string {
  const eol = example.includes('\r\n') ? '\r\n' : '\n'
  const missing = missingEnv(example, recipe)
  if (missing.length === 0) return example

  const block = [`# ${recipe.name} (nymbal add ${recipe.name})`]
  for (const v of missing) {
    if (v.comment !== '') block.push(`# ${v.comment}`)
    block.push(`${v.required ? '' : '# '}${v.name}=${v.example}`)
  }
  let head = example
  if (head !== '' && !head.endsWith('\n')) head += eol
  const last = head.split(/\r?\n/).at(-2)
  const gap = last === undefined || last.trim() === '' ? '' : eol
  return `${head}${gap}${block.join(eol)}${eol}`
}
