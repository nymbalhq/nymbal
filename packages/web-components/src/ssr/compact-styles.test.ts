import fc from 'fast-check'
import { LitElement, unsafeCSS } from 'lit'
import { describe, expect, it } from 'vitest'
import { ELEMENTS } from '../register-components.js'
import { registerServerElements, renderElement } from './index.js'

// The server collapses the indentation of an element's styles, which a page downloads once per element before its
// first paint. A CSS string is a value, not indentation: `content: "a  b"` must reach the page as written, and so must
// a string holding a quote of the other kind, an escaped quote or a `<`. A quote inside a comment opens no string.

/** One piece of a stylesheet and what it must look like after compaction. */
type Piece = { kind: 'ws' | 'code' | 'comment' | 'string'; text: string }

const ws = fc.stringMatching(/^[ \t\n]{1,4}$/).map((text): Piece => ({ kind: 'ws', text }))

const code = fc
  .constantFrom(
    'a',
    '.card',
    '::before',
    'content',
    'font-family',
    ':',
    ';',
    '{',
    '}',
    ',',
    '>',
    '1px',
    '#fff',
  )
  .map((text): Piece => ({ kind: 'code', text }))

const comment = fc
  .array(fc.constantFrom('note', ' ', '  ', '\t', '\n', '"', "'", '<', "it's", '{', '*'), {
    maxLength: 6,
  })
  .map((parts): Piece => ({ kind: 'comment', text: `/*${parts.join('')}*/` }))

const string = fc.constantFrom('"', "'").chain((quote) => {
  const other = quote === '"' ? "'" : '"'
  return fc
    .array(
      fc.constantFrom(
        'a',
        'B',
        ' ',
        '  ',
        '   ',
        '\t',
        ' \t ',
        other,
        `\\${quote}`,
        '\\\\',
        '<',
        '>',
        '/*',
        '*/',
        ';',
        '{',
      ),
      { maxLength: 8 },
    )
    .map((parts): Piece => ({ kind: 'string', text: `${quote}${parts.join('')}${quote}` }))
})

const stylesheet = fc.array(fc.oneof(ws, code, ws, comment, string), {
  minLength: 1,
  maxLength: 24,
})

/**
 * The CSS split as a browser tokenises it: comments first, then strings (a backslash escapes the next character), the
 * rest is code. Strings are kept whole, quotes included; everything else is "outside".
 */
function tokenise(css: string): { strings: string[]; outside: string[] } {
  const strings: string[] = []
  const outside: string[] = []
  let run = ''
  let i = 0
  while (i < css.length) {
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2)
      const stop = end === -1 ? css.length : end + 2
      run += css.slice(i, stop)
      i = stop
    } else if (css[i] === '"' || css[i] === "'") {
      const quote = css[i]!
      let j = i + 1
      while (j < css.length && css[j] !== quote) j += css[j] === '\\' ? 2 : 1
      outside.push(run)
      run = ''
      strings.push(css.slice(i, j + 1))
      i = j + 1
    } else {
      run += css[i]
      i += 1
    }
  }
  outside.push(run)
  return { strings, outside }
}

/** The first `<style>` of a rendered element: its own styles. */
function firstStyle(html: string): string {
  const start = html.indexOf('<style>')
  const end = html.indexOf('</style>', start)
  if (start === -1 || end === -1) throw new Error(`no <style> in ${html.slice(0, 200)}`)
  return html.slice(start + '<style>'.length, end)
}

let tags = 0

/** Renders a project element whose static styles are `css`, registered for the server, and returns its style text. */
function renderedStyles(css: string): string {
  const tag = `compact-styles-${++tags}`
  class Styled extends LitElement {
    static override styles = unsafeCSS(css)
    override render() {
      return 'styled'
    }
  }
  registerServerElements({ [tag]: Styled })
  return firstStyle(renderElement(tag))
}

const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '')
const withoutSpace = (text: string): string => text.replace(/\s+/g, '')

describe('the server’s style compaction', () => {
  it('AC-10: property: for CSS of rules, comments and single- or double-quoted strings, a project element’s server <style> keeps every quoted string byte for byte, leaves no run of two or more whitespace characters outside strings, drops no code, and compacting its output again changes nothing', () => {
    fc.assert(
      fc.property(stylesheet, (pieces) => {
        const css = pieces.map((p) => p.text).join('')
        const source = tokenise(css)
        expect(source.strings, 'the generator’s own strings').toEqual(
          pieces.filter((p) => p.kind === 'string').map((p) => p.text),
        )

        const out = renderedStyles(css)
        const compacted = tokenise(out)
        expect(compacted.strings, JSON.stringify(css)).toEqual(source.strings)
        for (const run of compacted.outside) {
          expect(run, `whitespace outside strings in ${JSON.stringify(out)}`).not.toMatch(/\s{2,}/)
        }
        expect(compacted.outside.map((r) => withoutSpace(withoutComments(r)))).toEqual(
          source.outside.map((r) => withoutSpace(withoutComments(r))),
        )

        expect(renderedStyles(out), 'compacting compacted styles').toBe(out)
      }),
      { numRuns: 200 },
    )
  })

  it('AC-10: every package element’s server <style> is its styles with each whitespace run made one space and the ends trimmed, as before', () => {
    const rendered = ELEMENTS.filter((e) => e.schema.tag !== 'nymbal-payment-element')
    expect(rendered.length).toBe(ELEMENTS.length - 1)
    for (const element of rendered) {
      const out = firstStyle(renderElement(element.schema.tag))
      const own = (element as unknown as typeof LitElement).elementStyles
        .map((s) => (s as { cssText: string }).cssText)
        .join('')
      expect(out, element.schema.tag).toBe(own.replace(/\s+/g, ' ').trim())
    }
  })
})
