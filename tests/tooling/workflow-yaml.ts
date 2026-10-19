// The block-YAML reader tests/tooling/ci-workflow.test.ts uses, shared for the tests that read a workflow. No YAML
// library is a dependency of the repo; this throws on anything outside the subset the workflows here use, so a misread
// fails loudly instead of passing quietly.

export type Yaml = string | null | Yaml[] | { [key: string]: Yaml }

export function parseYaml(source: string): Yaml {
  const raw = source.split('\n').map((line) => line.replace(/\r$/, ''))
  let i = 0

  const blank = (line: string): boolean => /^\s*(?:#.*)?$/.test(line)
  const indentOf = (line: string): number => {
    const lead = /^[ \t]*/.exec(line)![0]
    if (lead.includes('\t')) throw new Error(`line ${i + 1}: tab in indentation`)
    return lead.length
  }
  const isSeqItem = (text: string): boolean => /^-(?: |$)/.test(text)
  const MAP_ENTRY = /^("[^"]*"|'[^']*'|[^\s"'#\-[{][^:]*?):(?: +(.*))?$/

  function skipBlank(): void {
    while (i < raw.length && blank(raw[i]!)) i += 1
  }

  function stripComment(value: string): string {
    const v = value.trim()
    if (v.startsWith('"') || v.startsWith("'")) {
      const quote = v[0]!
      let j = 1
      while (j < v.length) {
        if (v[j] === quote) {
          if (quote === "'" && v[j + 1] === "'") {
            j += 2
            continue
          }
          break
        }
        if (quote === '"' && v[j] === '\\') j += 1
        j += 1
      }
      return v.slice(0, j + 1)
    }
    const hash = v.search(/\s#/)
    return (hash === -1 ? v : v.slice(0, hash)).trim()
  }

  function scalar(value: string): Yaml {
    const v = stripComment(value)
    if (/^[&*!%{@`]/.test(v) || /^[|>]/.test(v)) {
      throw new Error(`line ${i}: unsupported YAML construct: ${v}`)
    }
    if (v.startsWith("'")) return v.slice(1, -1).replaceAll("''", "'")
    if (v.startsWith('"')) {
      return v.slice(1, -1).replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c))
    }
    if (v.startsWith('[')) {
      if (!v.endsWith(']')) throw new Error(`line ${i}: multi-line flow sequence: ${v}`)
      const inner = v.slice(1, -1).trim()
      return inner === '' ? [] : inner.split(',').map((part) => scalar(part))
    }
    return v === '' || v === '~' || v === 'null' ? null : v
  }

  function blockScalar(parentIndent: number, indicator: string): string {
    const body: string[] = []
    let contentIndent: number | undefined
    while (i < raw.length) {
      const line = raw[i]!
      if (line.trim() === '') {
        body.push('')
        i += 1
        continue
      }
      const ind = indentOf(line)
      if (ind <= parentIndent) break
      contentIndent ??= ind
      body.push(line.slice(contentIndent))
      i += 1
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop()
    const text = indicator.startsWith('>') ? body.join(' ') : body.join('\n')
    return indicator.endsWith('-') ? text : `${text}\n`
  }

  function node(minIndent: number): Yaml {
    skipBlank()
    if (i >= raw.length) return null
    const ind = indentOf(raw[i]!)
    if (ind < minIndent) return null
    return isSeqItem(raw[i]!.trimStart()) ? sequence(ind) : mapping(ind)
  }

  function sequence(ind: number): Yaml[] {
    const out: Yaml[] = []
    for (;;) {
      skipBlank()
      if (i >= raw.length) break
      const line = raw[i]!
      const text = line.trimStart()
      if (indentOf(line) !== ind || !isSeqItem(text)) break
      const rest = text.slice(1)
      const content = rest.trimStart()
      if (content === '') {
        i += 1
        out.push(node(ind + 1))
      } else if (MAP_ENTRY.test(content)) {
        const col = ind + 1 + (rest.length - content.length)
        raw[i] = ' '.repeat(col) + content
        out.push(mapping(col))
      } else {
        i += 1
        out.push(scalar(content))
      }
    }
    return out
  }

  function mapping(ind: number): { [key: string]: Yaml } {
    const out: { [key: string]: Yaml } = {}
    for (;;) {
      skipBlank()
      if (i >= raw.length) break
      const line = raw[i]!
      const lineIndent = indentOf(line)
      if (lineIndent < ind) break
      if (lineIndent > ind) throw new Error(`line ${i + 1}: unexpected indentation: ${line}`)
      const text = line.trimStart()
      if (isSeqItem(text)) break
      const m = MAP_ENTRY.exec(text)
      if (m === null) throw new Error(`line ${i + 1}: not a mapping entry: ${text}`)
      const key = m[1]!.replace(/^(["'])(.*)\1$/, '$2')
      if (key in out) throw new Error(`line ${i + 1}: duplicate key ${key}`)
      const value = stripComment(m[2] ?? '')
      i += 1
      if (value === '') {
        skipBlank()
        const next = raw[i]
        if (next !== undefined && indentOf(next) === ind && isSeqItem(next.trimStart())) {
          out[key] = sequence(ind)
        } else {
          out[key] = node(ind + 1)
        }
      } else if (/^[|>][-+]?$/.test(value)) {
        out[key] = blockScalar(ind, value)
      } else {
        out[key] = scalar(value)
      }
    }
    return out
  }

  const doc = node(0)
  skipBlank()
  if (i < raw.length) throw new Error(`line ${i + 1}: unparsed content: ${raw[i]}`)
  return doc
}
